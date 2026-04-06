import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import type { StreamTextOnFinishCallback, ToolSet } from 'ai';
import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import { getDb } from '../lib/db';
import { buildSystemPrompt } from './system-prompt';
import { createFinancialTools } from './tools/financial';
import { createStorageTools } from './tools/storage';
import { createActionTools } from './tools/actions';
import type { Env } from '../index';

/**
 * ActionAgent — persistent conversational agent with tool-use.
 *
 * Each user gets their own Durable Object instance (keyed by userId).
 * Conversation history is automatically persisted in DO SQLite.
 * Tools provide read/write access to ChittyCommand's financial data
 * and ChittyStorage's document management.
 */
export class ActionAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const sql = getDb(this.env);

    // Build system prompt with live financial context
    let systemPrompt: string;
    try {
      systemPrompt = await buildSystemPrompt(sql);
    } catch (err) {
      console.error('[action-agent] system prompt build failed:', err instanceof Error ? err.message : err);
      systemPrompt = 'You are the ChittyCommand ActionAgent. Database context is temporarily unavailable — inform the user and offer to retry.';
    }

    // Create Workers AI model
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

    // Combine all tool sets
    const tools = {
      ...createFinancialTools(sql),
      ...createStorageTools(),
      ...createActionTools(this.env, sql),
    };

    const modelMessages = await convertToModelMessages(this.messages);

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onFinish: onFinish as unknown as StreamTextOnFinishCallback<typeof tools>,
    });

    return result.toUIMessageStreamResponse();
  }
}
