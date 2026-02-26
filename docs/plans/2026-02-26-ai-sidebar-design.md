# ChittyCommand AI Sidebar — Design Document

**Date:** 2026-02-26
**Status:** Approved
**Canonical URI:** `chittycanon://docs/design/chittycommand-ai-sidebar`

## Problem

ChittyCommand shows financial data and recommends actions, but users can't:
- Ask "why?" about a recommendation
- Explore "what if I defer this?" scenarios
- Correct wrong data inline
- Flag disagreements with reasoning
- Query across the full ChittyOS ecosystem from one place
- Trigger document signing, delivery, or evidence workflows
- Log bugs or issues without switching to GitHub

The Action Queue has approve/reject/defer — but no conversation. Users make decisions without understanding context.

## Solution

A persistent chat sidebar powered by ChittyGateway (Cloudflare AI Gateway) that:
1. Understands the current page context
2. Can read from 20+ ChittyOS ecosystem services
3. Can write decisions, corrections, and audit entries
4. Logs issues to GitHub automatically
5. Provides document lifecycle actions (mint, sign, deliver, verify)

## Architecture

```
ChittyCommand UI (React SPA)
  └── <ChatSidebar /> component
        ↓ POST /api/chat (SSE stream)
        ↓
  agent.chitty.cc/api/command/chat
        ↓
  chittyagent-command (new Cloudflare Worker)
  ├── LLM: ChittyGateway (CF AI Gateway)
  │   endpoint: gateway.ai.cloudflare.com/v1/{account}/chittygateway/compat/chat/completions
  │   auth: cf-aig-authorization: Bearer {CF_AIG_TOKEN}
  │   model: dynamic/{route-name}
  │
  ├── WRITE tools (actions that persist):
  │   ├── modify_action(id, new_action, reason)    → cc_decision_feedback + cc_recommendations
  │   ├── flag_dispute(id, reason)                  → cc_decision_feedback + status='disputed'
  │   ├── defer_with_reason(id, reason, until)      → cc_decision_feedback + priority bump
  │   ├── approve_action(id)                        → same as swipe approve
  │   ├── update_obligation(id, fields)             → cc_obligations + cc_actions_log
  │   ├── update_account(id, fields)                → cc_accounts + cc_actions_log
  │   ├── validate_item(id)                         → metadata.validated_at/by
  │   ├── flag_incorrect(id, reason)                → metadata.flagged_incorrect
  │   ├── add_source(target_id, doc_or_link)        → cc_documents link
  │   ├── create_github_issue(title, body, labels)  → GitHub API
  │   ├── add_github_comment(issue_id, body)        → GitHub API
  │   └── log_to_ledger(entry)                      → chittyledger (every write action)
  │
  ├── READ tools (ecosystem queries):
  │   ├── get_cash_position()                       → ChittyCommand Neon DB
  │   ├── get_obligation_detail(id)                 → cc_obligations + joined data
  │   ├── get_recommendation_detail(id)             → cc_recommendations + context
  │   ├── show_sources(target_id)                   → cc_documents + metadata.source + sync history
  │   ├── list_github_issues(filters)               → GitHub API
  │   ├── query_finance(entity, params)             → chittyagent-finance
  │   ├── query_communications(query, timerange)    → chittycontextual
  │   ├── query_evidence(query)                     → chittyevidence
  │   ├── query_timeline(case_ref)                  → chittychronicle
  │   ├── query_legal_facts(query)                  → chittyintel
  │   ├── query_assets()                            → chittyassets
  │   ├── query_property(property_id)               → chittyrental
  │   ├── query_trust_score(counterparty)           → chittyscore
  │   ├── get_active_context()                      → chittycontext
  │   └── verify_document(mint_id)                  → docuMint / chittyproof
  │
  ├── ACTION tools (ecosystem operations):
  │   ├── send_communication(to, subject, body)     → chittyconcierge
  │   ├── route_email(params)                       → chittyrouter (full AI gateway)
  │   ├── mint_document(doc, metadata)              → docuMint
  │   ├── sign_document(mint_id, signer)            → docuMint
  │   ├── deliver_document(mint_id, recipient)      → chittydlvr
  │   └── ingest_document(file, domain)             → chittyos-data
  │
  └── Service bindings (via orchestrator):
      ├── AGENT_FINANCE    → chittyagent-finance
      ├── AGENT_NOTION     → chittyagent-notion
      ├── AGENT_CLOUDFLARE → chittyagent-cloudflare
      └── (additional agents as needed)
```

## Frontend Design

### ChatSidebar Component

**Placement:** Right-side panel in `Layout.tsx`, overlays content.

**Toggle:** Button in StatusBar + keyboard shortcut (Cmd+J).

**Sizing:**
- Desktop: 400px wide, full height
- Mobile: Full-screen bottom sheet

**State:** Open/closed in localStorage. Messages in React state (not persisted for MVP).

### Context Awareness

The sidebar receives the current page route and any focused item ID:
- `/queue` → "Talking about: Action Queue" + current card details
- `/cashflow` → "Talking about: Cash Flow" + projection data
- `/bills` → "Talking about: Bills" + selected obligation
- `/disputes` → "Talking about: Disputes" + selected dispute
- `/legal` → "Talking about: Legal" + upcoming deadlines

### Suggested Quick Prompts

Context-dependent chips shown above the input:

| Page | Prompts |
|------|---------|
| Action Queue | "Why this?" / "What if I defer?" / "Change amount" / "Flag as wrong" |
| Cash Flow | "Why does balance drop?" / "What's my runway?" / "Revenue breakdown" |
| Bills | "Which can I negotiate?" / "What's overdue?" / "Show sources" |
| Disputes | "Draft response" / "Show evidence" / "Timeline for this case" |
| Legal | "Next deadline?" / "Any contradictions?" / "Case status" |
| Dashboard | "Financial summary" / "What needs attention?" / "Open issues" |

### Action Cards in Chat

When the AI executes a tool, an inline card appears in the chat:
- Green card: "Updated ComEd obligation: $180 → $145.23" with undo link
- Blue card: "Created GitHub issue #42: ComEd amount mismatch" with link
- Yellow card: "Deferred Mr. Cooper payment to March 15 — reason: waiting on escrow review"
- Purple card: "Logged to ChittyLedger: entry #1847"

## Backend: chittyagent-command Worker

### Location

New worker in `chittyos/chittyagent` repo at `workers/chittyagent-command/`.

### Endpoint

```
POST agent.chitty.cc/api/command/chat
Headers:
  Authorization: Bearer {user_token}
  Content-Type: application/json
Body:
  {
    "messages": [{ "role": "user", "content": "..." }, ...],
    "context": {
      "page": "/queue",
      "item_id": "uuid-of-focused-item",
      "persona": "litigation"  // from chittycontext
    }
  }
Response: text/event-stream (SSE)
```

### System Prompt Construction

The worker builds a system prompt dynamically:
1. Base identity: "You are ChittyCommand Assistant, an AI financial advisor..."
2. Current financial snapshot (cash position, overdue count, upcoming obligations)
3. Page-specific context (the focused item's full details)
4. Active persona from chittycontext
5. Available tools list

### LLM Call

```typescript
const response = await fetch(
  'https://gateway.ai.cloudflare.com/v1/{account_id}/chittygateway/compat/chat/completions',
  {
    headers: {
      'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dynamic/chittycommand',  // dynamic route in CF AI Gateway
      messages: [systemPrompt, ...userMessages],
      tools: toolDefinitions,
      stream: true,
    }),
  }
);
```

### Secrets

| Secret | Source | Purpose |
|--------|--------|---------|
| `CF_AIG_TOKEN` | `op://Private/ChittyGateway API Credentials/For ChittyCommand Use/api_token` | ChittyGateway auth |
| `NEON_DATABASE_URL` | Existing | ChittyCommand DB access |
| `GITHUB_TOKEN` | 1Password | Issue creation (scoped: issues only) |

### Audit Trail

Every write action automatically creates a ChittyLedger entry:
```typescript
await ledger.log({
  entityType: 'sidebar_action',
  entityId: targetId,
  action: toolName,
  actor: userId,
  actorType: 'user_via_ai',
  metadata: { tool_args, ai_reasoning, session_id }
});
```

## ChittyCommand UI Integration

### Proxy Route

ChittyCommand Worker gets a thin proxy route:

```typescript
// src/routes/chat.ts
chatRoutes.post('/', async (c) => {
  // Forward to chittyagent-command via orchestrator
  const response = await fetch('https://agent.chitty.cc/api/command/chat', {
    method: 'POST',
    headers: {
      'Authorization': c.req.header('Authorization'),
      'Content-Type': 'application/json',
    },
    body: c.req.raw.body,
  });
  // Stream SSE back to client
  return new Response(response.body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
});
```

### No New DB Tables

All persistence uses existing tables:
- `cc_decision_feedback` — action decisions with reasoning
- `cc_actions_log` — correction/modification audit trail
- `cc_documents` — source attachments
- `cc_recommendations` — status updates
- `cc_obligations` / `cc_accounts` — data corrections
- ChittyLedger — immutable log (external service)

## Phased Rollout

### Phase 1: MVP (implement now)
- ChatSidebar UI component with SSE streaming
- chittyagent-command worker with ChittyGateway LLM
- Core tools: modify_action, approve, defer, flag_dispute, flag_incorrect
- Read tools: cash position, obligation detail, show sources
- ChittyCommand Neon DB access only
- GitHub issue creation
- ChittyLedger audit logging

### Phase 2: Ecosystem Reads
- chittyagent-finance (balances, transactions)
- chittychronicle (timelines, deadlines)
- chittyintel (legal fact analysis)
- chittyevidence (exhibit lookup)
- chittycontextual (communications timeline)
- chittyos-data (document search)
- chittyassets (asset/net worth)
- chittyrental (property management)
- chittyconnect-finance (CFO operations)
- chittyscore (trust scoring)
- chittycontext (persona awareness)

### Phase 3: Ecosystem Actions
- chittyconcierge (send emails, follow-ups)
- chittyrouter (full AI gateway routing)
- docuMint (mint, sign documents)
- chittydlvr (certified delivery)
- chittyos-data (document intake)
- chittyproof (11-pillar verification)

### Phase 4: Full Platform
- chittymcp (44-tool MCP access)
- chittyreception (OpenPhone/Twilio calls)
- chittymac (Apple device: iMessage, Reminders, Notes)
- chittyforce (AI executive layer)
- Conversation persistence (KV or Neon)
- Multi-turn memory across sessions

## Out of Scope

- COA/GL structure for Mercury (separate design)
- Email bill parsing address correction (chittyrouter config change)
- Transaction categorization beyond revenue (expense classification)
- Voice interface
