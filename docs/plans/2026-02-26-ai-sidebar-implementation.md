# AI Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent AI chat sidebar to ChittyCommand that streams responses from ChittyGateway (Cloudflare AI Gateway), is context-aware per page, and can execute financial actions (modify, defer, approve, correct, flag).

**Architecture:** MVP puts the LLM proxy directly in the ChittyCommand Worker (`/api/chat`) calling ChittyGateway's OpenAI-compatible endpoint. The React sidebar streams SSE responses. Later, this migrates to a dedicated `chittyagent-command` worker behind the orchestrator. No new DB tables — all writes use existing `cc_*` tables.

**Tech Stack:** Hono (backend route), React + Tailwind (sidebar UI), ChittyGateway (CF AI Gateway, OpenAI-compatible), SSE streaming, existing ChittyCommand Neon DB.

**Design doc:** `docs/plans/2026-02-26-ai-sidebar-design.md`

---

### Task 1: Add chat route with ChittyGateway streaming proxy

**Files:**
- Create: `src/routes/chat.ts`
- Modify: `src/index.ts:22-105` (import + mount route)

**Step 1: Create `src/routes/chat.ts`**

```typescript
import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';

export const chatRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  context?: { page?: string; item_id?: string };
}

// Build system prompt with financial context from DB
async function buildSystemPrompt(
  env: Env,
  context?: ChatRequest['context'],
): Promise<string> {
  const sql = getDb(env);

  // Fetch cash position snapshot
  const [cash] = await sql`
    SELECT COALESCE(SUM(current_balance), 0) as total
    FROM cc_accounts WHERE account_type IN ('checking', 'savings')
  `;
  const [overdue] = await sql`
    SELECT COUNT(*) as count,
           COALESCE(SUM(COALESCE(amount_due::numeric, 0)), 0) as total
    FROM cc_obligations WHERE status = 'overdue'
  `;
  const [dueSoon] = await sql`
    SELECT COUNT(*) as count
    FROM cc_obligations
    WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'
  `;

  let contextBlock = '';

  // Add page-specific context
  if (context?.page === '/queue' && context?.item_id) {
    const [item] = await sql`
      SELECT r.*, o.payee, o.amount_due, o.due_date, o.category, o.status as ob_status
      FROM cc_recommendations r
      LEFT JOIN cc_obligations o ON r.obligation_id = o.id
      WHERE r.id = ${context.item_id}::uuid
    `;
    if (item) {
      contextBlock = `\n\nCurrently viewing action queue item: "${item.title}"
Payee: ${item.payee || 'N/A'}, Amount: $${item.amount_due || '?'}, Due: ${item.due_date || '?'}
Category: ${item.category || '?'}, Status: ${item.ob_status || '?'}
AI reasoning: ${item.reasoning || 'N/A'}`;
    }
  } else if (context?.page === '/bills' && context?.item_id) {
    const [ob] = await sql`
      SELECT * FROM cc_obligations WHERE id = ${context.item_id}::uuid
    `;
    if (ob) {
      contextBlock = `\n\nCurrently viewing obligation: ${ob.payee}
Amount: $${ob.amount_due}, Due: ${ob.due_date}, Status: ${ob.status}
Category: ${ob.category}, Auto-pay: ${ob.auto_pay}`;
    }
  }

  return `You are the ChittyCommand Assistant — an AI financial advisor embedded in a life management dashboard.

Current financial snapshot:
- Cash position: $${Number(cash.total).toLocaleString()}
- Overdue bills: ${overdue.count} totaling $${Number(overdue.total).toLocaleString()}
- Due this week: ${dueSoon.count}
${contextBlock}

You help the user understand their financial position, explain recommendations, explore what-if scenarios, and take actions on their behalf when asked. Be concise and direct. Use dollar amounts and dates. When you don't know something, say so.`;
}

chatRoutes.post('/', async (c) => {
  const gatewayToken = await c.env.COMMAND_KV.get('chat:cf_aig_token');
  if (!gatewayToken) {
    return c.json({ error: 'Chat not configured — missing gateway token' }, 503);
  }

  const body = await c.req.json<ChatRequest>();
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages array required' }, 400);
  }

  const systemPrompt = await buildSystemPrompt(c.env, body.context);

  const gatewayUrl = 'https://gateway.ai.cloudflare.com/v1/0bc21e3a5a9de1a4cc843be9c3e98121/chittygateway/compat/chat/completions';

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'cf-aig-authorization': `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dynamic/chittycommand',
      messages: [
        { role: 'system', content: systemPrompt },
        ...body.messages.slice(-20), // Last 20 messages to stay within context
      ],
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'Gateway error');
    console.error('[chat] gateway error:', response.status, err);
    return c.json({ error: 'AI gateway error' }, 502);
  }

  // Stream SSE back to client
  return new Response(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
```

**Step 2: Mount the route in `src/index.ts`**

Add import:
```typescript
import { chatRoutes } from './routes/chat';
```

Add route mount after the other `/api/*` routes (after line 105):
```typescript
app.route('/api/chat', chatRoutes);
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean (no errors)

**Step 4: Commit**

```bash
git add src/routes/chat.ts src/index.ts
git commit -m "feat: add /api/chat route with ChittyGateway streaming proxy"
```

---

### Task 2: Add Env type for gateway token and store secret

**Files:**
- Modify: `src/index.ts:24-43` (Env type — no change needed if using KV)

**Step 1: Verify KV approach**

The route reads `chat:cf_aig_token` from `COMMAND_KV`. Store the token via wrangler:

```bash
# Read token from 1Password, pipe to KV — never expose in terminal
op read "op://Private/ChittyGateway API Credentials/For ChittyCommand Use/api_token" \
  | xargs -I{} npx wrangler kv key put "chat:cf_aig_token" "{}" \
    --namespace-id=$(npx wrangler kv list | jq -r '.[] | select(.title=="chittycommand-kv") | .id') \
    --remote > /dev/null 2>&1
```

**Step 2: Verify**

```bash
npx wrangler kv key get "chat:cf_aig_token" \
  --namespace-id=<id> --remote | head -c 10
```

Expected: First 10 chars of the token (verify it's there, don't print all).

No commit needed — this is a deploy-time config step.

---

### Task 3: Add streaming chat API client in the frontend

**Files:**
- Modify: `ui/src/lib/api.ts` (add `chatStream` function + `ChatMessage` type)

**Step 1: Add types and streaming function**

At the end of `ui/src/lib/api.ts`, before the closing types section, add to the `api` object:

```typescript
// Chat (streaming)
chatStream: async function* (
  messages: ChatMessage[],
  context?: { page?: string; item_id?: string },
): AsyncGenerator<string> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages, context }),
  });

  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // Skip malformed chunks
      }
    }
  }
},
```

Add the ChatMessage type:

```typescript
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

**Step 2: Type-check frontend**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

**Step 3: Commit**

```bash
git add ui/src/lib/api.ts
git commit -m "feat(ui): add streaming chat API client for AI sidebar"
```

---

### Task 4: Create ChatSidebar React component

**Files:**
- Create: `ui/src/components/ChatSidebar.tsx`

**Step 1: Create the component**

```typescript
import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type ChatMessage } from '../lib/api';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';

const QUICK_PROMPTS: Record<string, string[]> = {
  '/queue': ['Why this recommendation?', 'What if I defer?', 'Change the amount'],
  '/cashflow': ['Why does balance drop?', "What's my runway?", 'Revenue breakdown'],
  '/bills': ['Which can I negotiate?', "What's overdue?", 'Show sources'],
  '/disputes': ['Draft a response', 'Show evidence', 'Case timeline'],
  '/legal': ['Next deadline?', 'Any contradictions?', 'Case status'],
  '/': ['Financial summary', 'What needs attention?', 'Open issues'],
};

export function ChatSidebar() {
  const [open, setOpen] = useState(() => localStorage.getItem('chat-sidebar-open') === 'true');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const abortRef = useRef<AbortController | null>(null);

  // Persist open/close state
  useEffect(() => {
    localStorage.setItem('chat-sidebar-open', String(open));
  }, [open]);

  // Keyboard shortcut: Cmd+J to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || streaming) return;

    const userMsg: ChatMessage = { role: 'user', content: content.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
    setMessages([...newMessages, assistantMsg]);

    try {
      const stream = api.chatStream(newMessages, { page: location.pathname });
      let accumulated = '';

      for await (const chunk of stream) {
        accumulated += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: accumulated };
          return updated;
        });
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`,
        };
        return updated;
      });
    } finally {
      setStreaming(false);
    }
  }, [messages, streaming, location.pathname]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const prompts = QUICK_PROMPTS[location.pathname] || QUICK_PROMPTS['/'];

  // Toggle button (always visible)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 z-50 w-12 h-12 rounded-full bg-chitty-600 hover:bg-chitty-500 text-white shadow-lg flex items-center justify-center transition-colors"
        title="Open AI Assistant (Cmd+J)"
      >
        <MessageSquare size={20} />
      </button>
    );
  }

  return (
    <>
      {/* Mobile overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
        onClick={() => setOpen(false)}
      />

      {/* Sidebar panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 lg:w-[400px] bg-chrome-surface border-l border-chrome-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between h-12 px-4 border-b border-chrome-border shrink-0">
          <span className="text-sm font-semibold text-chrome-text">AI Assistant</span>
          <button
            onClick={() => setOpen(false)}
            className="p-1 text-chrome-muted hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <MessageSquare size={32} className="mx-auto text-chrome-muted mb-3" />
              <p className="text-chrome-muted text-sm mb-4">Ask about your finances, actions, or data</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {prompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className="text-xs px-3 py-1.5 rounded-full border border-chrome-border text-chrome-muted hover:text-white hover:border-chitty-600 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-chitty-600 text-white'
                    : 'bg-chrome-border/50 text-chrome-text'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          ))}

          {streaming && messages[messages.length - 1]?.content === '' && (
            <div className="flex justify-start">
              <div className="bg-chrome-border/50 rounded-lg px-3 py-2">
                <Loader2 size={16} className="animate-spin text-chrome-muted" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick prompts when mid-conversation */}
        {messages.length > 0 && !streaming && (
          <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
            {prompts.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                onClick={() => sendMessage(prompt)}
                className="text-xs px-2.5 py-1 rounded-full border border-chrome-border text-chrome-muted hover:text-white hover:border-chitty-600 transition-colors shrink-0"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <form onSubmit={handleSubmit} className="p-3 border-t border-chrome-border shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              rows={1}
              className="flex-1 resize-none rounded-lg bg-chrome-bg border border-chrome-border px-3 py-2 text-sm text-chrome-text placeholder:text-chrome-muted focus:outline-none focus:border-chitty-600 max-h-24"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="p-2 rounded-lg bg-chitty-600 text-white disabled:opacity-40 hover:bg-chitty-500 transition-colors shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-chrome-muted mt-1.5 text-center">Cmd+J to toggle</p>
        </form>
      </div>
    </>
  );
}
```

**Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

**Step 3: Commit**

```bash
git add ui/src/components/ChatSidebar.tsx
git commit -m "feat(ui): create ChatSidebar component with streaming and context-aware prompts"
```

---

### Task 5: Mount ChatSidebar in Layout

**Files:**
- Modify: `ui/src/components/Layout.tsx`

**Step 1: Add ChatSidebar import and render**

Add import at top:
```typescript
import { ChatSidebar } from './ChatSidebar';
```

Add `<ChatSidebar />` inside the Layout return, after the `<MobileNav />` closing tag but still inside the outer `<div>`:

```tsx
        <MobileNav />
      </div>

      {/* AI Chat Sidebar */}
      <ChatSidebar />
    </div>
```

**Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

**Step 3: Commit**

```bash
git add ui/src/components/Layout.tsx
git commit -m "feat(ui): mount ChatSidebar in Layout"
```

---

### Task 6: Build verification and push

**Step 1: Full type-check (both backend and frontend)**

Run: `npx tsc --noEmit && cd ui && npx tsc --noEmit`
Expected: both clean

**Step 2: Build frontend**

Run: `cd ui && npm run build`
Expected: successful build

**Step 3: Push**

```bash
git push
```

---

## Deployment Steps (post-merge)

1. Store the ChittyGateway token in KV (Task 2)
2. Set up a `dynamic/chittycommand` route in the Cloudflare AI Gateway dashboard
3. Deploy: `npm run deploy`
4. Test: Open `app.command.chitty.cc`, click the chat bubble or press Cmd+J, ask "What's my cash position?"

## Future Tasks (not in this plan)

- **chittyagent-command worker** — migrate LLM call from chittycommand to dedicated agent in chittyagent repo
- **Tool use** — add function calling for modify_action, flag_dispute, etc.
- **Ecosystem reads** — bind chittyagent-finance, chittychronicle, etc.
- **Action cards** — render tool execution results as styled cards in chat
- **ChittyLedger audit logging** — log every sidebar action
- **GitHub issue creation** — create issues from chat
