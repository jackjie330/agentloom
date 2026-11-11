import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';
import {
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
  tool,
  type ToolRuntime,
} from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callTool, ScriptedModel } from './helpers.js';

const contextSchema = z.object({ tenantId: z.string(), userId: z.string() });
const context = { tenantId: 'tenant-a', userId: 'user-a' };
const input = { messages: [new HumanMessage('hello')] };
const config = (thread = 'conversation-1') => ({
  configurable: { thread_id: thread },
  context,
});

function fixture(responses: (AIMessage | Error)[], approval = false) {
  const model = new ScriptedModel(responses);
  const execute = vi.fn(
    (value: string, identity: z.infer<typeof contextSchema>) =>
      `${identity.tenantId}/${identity.userId}: ${value}`,
  );
  const echo = tool(
    (args, runtime: ToolRuntime<unknown, typeof contextSchema>) =>
      execute(args.value, runtime.context),
    {
      name: 'echo',
      description: 'Return text with trusted runtime identity.',
      schema: z.object({ value: z.string() }),
    },
  );
  const checkpointer = new MemorySaver();
  const options = {
    model,
    tools: [echo],
    contextSchema,
    checkpointer,
    ...(approval
      ? {
          interruptOn: {
            echo: {
              allowedDecisions: ['approve', 'reject'] as (
                'approve' | 'reject'
              )[],
            },
          },
        }
      : {}),
  };
  return { agent: createDeepAgent(options), options, model, execute };
}

async function drain(
  stream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
) {
  const events: unknown[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

describe('locked Deep Agents JS API', () => {
  it('streams tools and messages, passes trusted context, reads latest state and retains history', async () => {
    const { agent, model, execute } = fixture([
      callTool('echo', { value: 'hi' }),
      new AIMessage('first answer'),
      new AIMessage('second answer'),
    ]);
    const events = await drain(
      await agent.stream(input, {
        ...config(),
        streamMode: ['messages', 'updates'],
      }),
    );
    expect(
      events.some((event) => Array.isArray(event) && event[0] === 'messages'),
    ).toBe(true);
    expect(
      events.some((event) => Array.isArray(event) && event[0] === 'updates'),
    ).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith('hi', context);
    const state = await agent.graph.getState(config());
    expect(state.next).toEqual([]);
    expect(state.values.messages.at(-1).content).toBe('first answer');
    expect(
      state.values.messages.some(
        (m: unknown) =>
          m instanceof ToolMessage && m.content === 'tenant-a/user-a: hi',
      ),
    ).toBe(true);
    const calls = model.seen.length;
    // getState is a runtime alias, despite its never return declaration.
    const aliasState = (await agent.getState(config())) as typeof state;
    expect(aliasState.values).toEqual(state.values);
    expect(model.seen).toHaveLength(calls);
    await drain(
      await agent.stream(
        { messages: [new HumanMessage('follow up')] },
        config(),
      ),
    );
    const latest = await agent.graph.getState(config());
    expect(latest.values.messages.at(-1).content).toBe('second answer');
    expect(
      latest.values.messages.filter((m: unknown) => m instanceof HumanMessage),
    ).toHaveLength(2);
    expect(
      (await agent.graph.getState(config('other-conversation'))).values,
    ).toEqual({});
  });

  it('default StateBackend stores virtual files in checkpoint state, not the host filesystem', async () => {
    const { agent } = fixture([
      callTool('write_file', {
        file_path: '/note.txt',
        content: 'virtual only',
      }),
      new AIMessage('saved'),
    ]);
    await drain(await agent.stream(input, config()));
    const snapshot = await agent.graph.getState(config());
    expect(snapshot.values.files['/note.txt'].content).toBe('virtual only');
    expect(snapshot.next).toEqual([]);
  });

  it('saves model errors without retry and continues pending work with null using a fresh agent', async () => {
    const { agent, options, model } = fixture([
      new Error('controlled model failure'),
      new AIMessage('recovered'),
    ]);
    await expect(drain(agent.stream(input, config()))).rejects.toThrow(
      'controlled model failure',
    );
    expect(model.seen).toHaveLength(1);
    const snapshot = await agent.graph.getState(config());
    expect(snapshot.next.length).toBeGreaterThan(0);
    expect(snapshot.tasks.some((task) => task.error !== undefined)).toBe(true);
    expect(snapshot.values.messages.at(-1).content).toBe('hello');
    const recreated = createDeepAgent(options);
    await drain(await recreated.stream(null, config()));
    expect(model.seen).toHaveLength(2);
    expect((await recreated.graph.getState(config())).next).toEqual([]);
    expect(
      (await recreated.graph.getState(config())).values.messages.at(-1).content,
    ).toBe('recovered');
  });

  it.each(['approve', 'reject'] as const)(
    'persists HITL and resumes with Command: %s',
    async (decision) => {
      const { agent, options, execute } = fixture(
        [callTool('echo', { value: 'approval' }), new AIMessage('finished')],
        true,
      );
      await drain(await agent.stream(input, config()));
      expect(execute).not.toHaveBeenCalled();
      const snapshot = await agent.graph.getState(config());
      const interrupts = snapshot.tasks.flatMap((task) => task.interrupts);
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0].value).toMatchObject({
        actionRequests: [{ name: 'echo', args: { value: 'approval' } }],
        reviewConfigs: [{ allowedDecisions: ['approve', 'reject'] }],
      });
      // A plain null continuation must not bypass approval.
      await drain(await agent.stream(null, config()));
      expect(execute).not.toHaveBeenCalled();
      expect(
        (await agent.graph.getState(config())).tasks.flatMap(
          (task) => task.interrupts,
        ),
      ).toHaveLength(1);
      const recreated = createDeepAgent(options);
      await drain(
        await recreated.stream(
          new Command({ resume: { decisions: [{ type: decision }] } }),
          config(),
        ),
      );
      expect(execute).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
      const final = await recreated.graph.getState(config());
      expect(final.next).toEqual([]);
      expect(final.values.messages.at(-1).content).toBe('finished');
      if (decision === 'reject')
        expect(
          final.values.messages.some(
            (m: unknown) =>
              m instanceof ToolMessage && /reject|denied/i.test(m.text),
          ),
        ).toBe(true);
    },
  );

  it('retains the native model runLimit count after errors', async () => {
    const { options, model } = fixture([
      callTool('echo', { value: 'one' }),
      new AIMessage('done'),
    ]);
    const agent = createDeepAgent({
      ...options,
      middleware: [
        modelCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' }),
      ],
    });
    await expect(drain(agent.stream(input, config()))).rejects.toThrow(
      /limit/i,
    );
    expect(model.seen).toHaveLength(1);
    expect((await agent.graph.getState(config())).next.length).toBeGreaterThan(
      0,
    );
    await expect(drain(agent.stream(null, config()))).rejects.toThrow(/limit/i);
    expect(model.seen).toHaveLength(1);
    // A separate thread has its own budget.
    await drain(await agent.stream(input, config('fresh')));
    expect(model.seen).toHaveLength(2);
  });

  it.each(['model', 'tool'] as const)(
    'supports fresh invocation-local %s counters when explicitly continuing',
    async (kind) => {
      const { options, execute, model } = fixture([
        callTool('echo', { value: 'one' }),
        callTool('echo', { value: 'two' }, 'call-2'),
        new AIMessage('done'),
      ]);
      // Only an SDK hook compatibility probe: no HTTP/business execution wrapper.
      function invocationAgent() {
        let count = 0;
        return createDeepAgent({
          ...options,
          middleware: [
            createMiddleware({
              name: 'InvocationLimitProbe',
              wrapModelCall: async (request, handler) => {
                if (kind === 'model' && ++count > 2)
                  throw new Error('invocation limit');
                return handler(request);
              },
              wrapToolCall: async (request, handler) => {
                if (kind === 'tool' && ++count > 1)
                  throw new Error('invocation limit');
                return handler(request);
              },
            }),
          ],
        });
      }
      const first = invocationAgent();
      await expect(drain(first.stream(input, config()))).rejects.toThrow(
        'invocation limit',
      );
      expect(execute).toHaveBeenCalledTimes(kind === 'model' ? 2 : 1);
      expect(
        (await first.graph.getState(config())).next.length,
      ).toBeGreaterThan(0);
      const continued = invocationAgent();
      await drain(continued.stream(null, config()));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(model.seen).toHaveLength(3);
      expect((await continued.graph.getState(config())).next).toEqual([]);
    },
  );

  it('native model runLimit resets on normal completion for subsequent inputs', async () => {
    const { options, model } = fixture([
      new AIMessage('one'),
      new AIMessage('two'),
    ]);
    const agent = createDeepAgent({
      ...options,
      middleware: [
        modelCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' }),
      ],
    });
    await drain(await agent.stream(input, config()));
    await drain(await agent.stream(input, config()));
    expect(model.seen).toHaveLength(2);
  });

  it('bounds tool execution and exposes unfinished work after a native limit error', async () => {
    const { options, execute } = fixture([
      callTool('echo', { value: 'one' }),
      callTool('echo', { value: 'two' }, 'call-2'),
      new AIMessage('done'),
    ]);
    const agent = createDeepAgent({
      ...options,
      middleware: [
        toolCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' }),
      ],
    });
    await expect(drain(agent.stream(input, config()))).rejects.toThrow(
      /limit/i,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await agent.graph.getState(config())).next.length).toBeGreaterThan(
      0,
    );
    await expect(drain(agent.stream(null, config()))).rejects.toThrow(/limit/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
