import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { expect, it } from 'vitest';
import { createConversationAgent } from '../src/modules/agent/agent.js';
import { callTool, ScriptedModel } from './helpers.js';

it.each([
  undefined,
  { tenantId: '', userId: 'user-a' },
  { tenantId: 'tenant-a', userId: '' },
])('rejects invalid context before model calls: %j', async (context) => {
  const model = new ScriptedModel([new AIMessage('unexpected')]);
  const agent = createConversationAgent({
    model,
    checkpointer: new MemorySaver(),
  });
  await expect(
    agent.invoke(
      { messages: [{ role: 'user', content: 'hello' }] },
      // @ts-expect-error Missing context deliberately tests runtime validation.
      { configurable: { thread_id: 'invalid-context' }, context },
    ),
  ).rejects.toThrow();
  expect(model.seen).toHaveLength(0);
});

it('constructs without model calls and persists conversation history through the SDK', async () => {
  const model = new ScriptedModel([
    callTool('echo', { text: 'hello' }),
    new AIMessage('first answer'),
    new AIMessage('second answer'),
  ]);
  const checkpointer = new MemorySaver();
  const agent = createConversationAgent({ model, checkpointer });
  expect(model.seen).toHaveLength(0);
  const config = {
    configurable: { thread_id: 'conversation-a' },
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  };
  await agent.invoke(
    { messages: [{ role: 'user', content: 'hello' }] },
    config,
  );
  const recreated = createConversationAgent({ model, checkpointer });
  const snapshot = await recreated.graph.getState(config);
  expect(snapshot.values.messages.at(-1).content).toBe('first answer');
  expect(
    snapshot.values.messages.some(
      (message: { content: unknown }) => message.content === 'hello',
    ),
  ).toBe(true);
  await recreated.invoke(
    { messages: [{ role: 'user', content: 'follow up' }] },
    config,
  );
  expect(
    (await recreated.graph.getState(config)).values.messages.at(-1).content,
  ).toBe('second answer');
  expect(
    (await recreated.graph.getState({ configurable: { thread_id: 'other' } }))
      .values,
  ).toEqual({});
});
