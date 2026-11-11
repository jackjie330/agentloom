import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

// A small scripted model shared by all SDK tests, not a production model option.
export class ScriptedModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];

  constructor(private readonly responses: (AIMessage | Error)[]) {
    super({ maxRetries: 0 });
  }

  _llmType() {
    return 'scripted-test';
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    const response = this.responses.shift();
    if (!response) throw new Error('Unexpected model call: script exhausted');
    if (response instanceof Error) throw response;
    return { generations: [{ message: response, text: response.text }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[]) {
    const result = await this._generate(messages);
    const message = result.generations[0].message as AIMessage;
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: message.content,
        tool_calls: message.tool_calls,
      }),
      text: message.text,
    });
  }
}

export function callTool(
  name: string,
  args: Record<string, unknown>,
  id = 'call-1',
) {
  return new AIMessage({
    content: '',
    tool_calls: [{ name, args, id, type: 'tool_call' }],
  });
}
