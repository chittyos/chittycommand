/**
 * MCP server tests — JSON-RPC 2.0 protocol, tool listing, success/error paths,
 * and defensive parsing. Uses a minimal Hono app with a mocked Env binding so
 * no real database or external services are required.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/index';
import { mcpAuthMiddleware } from '../src/middleware/auth';
import type { AuthVariables } from '../src/middleware/auth';

// Mock the db module before importing routes that depend on it
vi.mock('../src/lib/db', () => ({
  getDb: vi.fn(() => {
    // Return a mock sql tagged-template that resolves to an empty array
    const sql = vi.fn().mockResolvedValue([]);
    return sql;
  }),
  typedRows: <T>(rows: readonly Record<string, unknown>[]): T[] =>
    rows as unknown as T[],
}));

import { mcpRoutes } from '../src/routes/mcp';

// Partial mock of Cloudflare bindings — only the fields exercised by the MCP handler.
type MockEnv = Pick<Env, 'ENVIRONMENT' | 'COMMAND_KV'> & Partial<Env>;

// ---------------------------------------------------------------------------
// Minimal Env mock — only the bindings exercised by the MCP handler under test
// ---------------------------------------------------------------------------
function makeMockEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    ENVIRONMENT: 'test',
    COMMAND_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper — build a minimal Hono app that exposes the MCP routes.
// ---------------------------------------------------------------------------
function buildApp(envOverrides: Partial<MockEnv> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  const env = makeMockEnv(envOverrides);

  // Wire the same auth middleware as production — dev bypass sets userId/scopes
  // automatically when ENVIRONMENT !== 'production' (mock uses 'test').
  app.use('/mcp/*', mcpAuthMiddleware);
  app.route('/mcp', mcpRoutes);

  async function post(body: unknown) {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return app.fetch(req, env as unknown as Env);
  }

  async function postRaw(body: string) {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return app.fetch(req, env as unknown as Env);
  }

  async function get() {
    const req = new Request('http://localhost/mcp', { method: 'GET' });
    return app.fetch(req, env as unknown as Env);
  }

  return { post, postRaw, get, env };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 protocol conformance
// ---------------------------------------------------------------------------
describe('MCP — JSON-RPC protocol', () => {
  it('responds to initialize with protocolVersion and serverInfo', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    const result = json.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeDefined();
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe('chittycommand-mcp');
  });

  it('returns 204 with no body for notifications/initialized', async () => {
    const { post } = buildApp();
    // Notifications have no id per JSON-RPC 2.0 spec
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns -32600 for non-2.0 JSON-RPC version', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '1.0', id: 2, method: 'initialize' });
    const json = await res.json() as Record<string, unknown>;
    const error = json.error as Record<string, unknown>;
    expect(error.code).toBe(-32600);
  });

  it('returns -32601 for unknown method', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'not_a_real_method' });
    const json = await res.json() as Record<string, unknown>;
    const error = json.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
  });

  it('echoes request id in all responses', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 'abc-123', method: 'tools/list' });
    const json = await res.json() as Record<string, unknown>;
    expect(json.id).toBe('abc-123');
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------
describe('MCP — tools/list', () => {
  it('returns an array of tools', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const json = await res.json() as Record<string, unknown>;
    const result = json.result as Record<string, unknown>;
    const tools = result.tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes exactly 38 tools', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const json = await res.json() as Record<string, unknown>;
    const result = json.result as Record<string, unknown>;
    const tools = result.tools as unknown[];
    expect(tools.length).toBe(38);
  });

  it('each tool has a name and inputSchema', async () => {
    const { post } = buildApp();
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const json = await res.json() as Record<string, unknown>;
    const result = json.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// tools/call — success paths (no real DB / external services needed)
// ---------------------------------------------------------------------------
describe('MCP — tools/call success paths', () => {
  it('get_schema_refs returns endpoints and db_tables', async () => {
    const { post } = buildApp();
    const res = await post({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_schema_refs', arguments: {} },
    });
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBeUndefined();
    const result = json.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
    const parsed = JSON.parse(content[0].text as string);
    expect(Array.isArray(parsed.endpoints)).toBe(true);
    expect(Array.isArray(parsed.db_tables)).toBe(true);
  });

  it('whoami returns client identity', async () => {
    const { post } = buildApp();
    const res = await post({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBeUndefined();
    const result = json.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// tools/call — error paths
// ---------------------------------------------------------------------------
describe('MCP — tools/call error paths', () => {
  it('returns isError:true for unknown tool name', async () => {
    const { post } = buildApp();
    const res = await post({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'totally_fake_tool', arguments: {} },
    });
    const json = await res.json() as Record<string, unknown>;
    // Per MCP spec, tool errors surface as result.isError rather than JSON-RPC error
    const result = json.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
  });

  it('returns isError:true when required argument is missing (ledger_get_evidence)', async () => {
    const { post } = buildApp();
    // ledger_get_evidence requires case_id; passing empty args triggers the guard
    const res = await post({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ledger_get_evidence', arguments: {} },
    });
    const json = await res.json() as Record<string, unknown>;
    const result = json.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    const text = (content[0].text as string).toLowerCase();
    expect(text).toContain('case_id');
  });
});

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------
describe('MCP — defensive parsing', () => {
  it('handles completely empty body gracefully', async () => {
    const { postRaw } = buildApp();
    const res = await postRaw('');
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBeNull();
    const error = json.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);
  });

  it('handles non-JSON body without crashing', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    const env = makeMockEnv();
    app.use('/mcp/*', mcpAuthMiddleware);
    app.route('/mcp', mcpRoutes);
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    const res = await app.fetch(req, env as unknown as Env);
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBeNull();
    const error = json.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);
  });

  it('GET /mcp returns service health info', async () => {
    const { get } = buildApp();
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.service).toBe('chittycommand-mcp');
    expect(json.status).toBe('ok');
  });
});
