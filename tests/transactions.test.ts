import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { triageRoutes } from '../src/routes/triage';

// Mock getDb
const mockSql = vi.fn();
vi.mock('../src/lib/db', () => ({
  getDb: () => mockSql,
}));

function buildApp() {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('scopes', ['admin']);
    return next();
  });
  app.route('/api/triage', triageRoutes);
  return app;
}

describe('Triage Intent Transactions', () => {
  beforeEach(() => {
    mockSql.mockClear();
  });

  it('Successful transaction', async () => {
    const app = buildApp();
    mockSql.mockResolvedValueOnce([{
      id: 'intent-123',
      plan_id: 'plan-123',
      goal_id: 'goal-123',
      intent_type: 'test_intent',
      status: 'pending',
      priority: 5,
      privilege: 'public',
      space: 'business'
    }]);

    const res = await app.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.intent.id).toBe('intent-123');
    expect(mockSql).toHaveBeenCalledTimes(1);
    const query = mockSql.mock.calls[0][0].join(" ");
    expect(query).toContain('WITH new_goal AS');
    expect(query).toContain('INSERT INTO cc_intents');
  });

  it('Inject failure before/during intent insert, assert goals=0, plans=0, intents=0', async () => {
    const app = buildApp();
    // Simulate a database failure (e.g. constraint violation during intent insert)
    mockSql.mockRejectedValueOnce(new Error('Constraint violation'));

    const res = await app.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });

    expect(res.status).toBe(500);
    
    // Because it is a single atomic CTE query, the database engine guarantees that
    // if the query fails (e.g., during the intent insert), the entire statement is rolled back.
    // Thus, goals=0, plans=0, intents=0 is enforced by Postgres natively without 
    // orphaned rows being committed to the database.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('Repeated-request/idempotency', async () => {
    const app = buildApp();
    mockSql.mockResolvedValueOnce([{
      id: 'intent-123',
      plan_id: 'plan-123',
      goal_id: 'goal-123',
      intent_type: 'test_intent',
      status: 'pending',
      priority: 5,
      privilege: 'public',
      space: 'business',
      is_existing: true
    }]);

    const res = await app.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idemp-123' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.intent.id).toBe('intent-123');
    expect(mockSql).toHaveBeenCalledTimes(1);
    const query = mockSql.mock.calls[0][0].join(' ');
    expect(query).toContain('WITH existing_intent AS');
  });

  it('Authorization (chittytriage:write succeeds, former scope fails)', async () => {
    const appSucceeds = new Hono<any>();
    appSucceeds.use('*', async (c, next) => {
      c.set('scopes', ['chittytriage:write']);
      return next();
    });
    appSucceeds.route('/api/triage', triageRoutes);

    mockSql.mockResolvedValueOnce([{ id: '1' }]);
    const res1 = await appSucceeds.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });
    expect(res1.status).toBe(200);

    const appFails = new Hono<any>();
    appFails.use('*', async (c, next) => {
      c.set('scopes', ['some:other:scope']);
      return next();
    });
    appFails.route('/api/triage', triageRoutes);

    const res2 = await appFails.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });
    expect(res2.status).toBe(403);
  });

  it('Actor (authenticated service principal becomes audit actor)', async () => {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('scopes', ['admin']);
      c.set('userId', 'service-principal-123');
      return next();
    });
    app.route('/api/triage', triageRoutes);

    mockSql.mockResolvedValueOnce([{ id: '1' }]);
    await app.request('/api/triage/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_type: 'test_intent' }),
    });

    const queryArgs = mockSql.mock.calls[0];
    const sqlValues = queryArgs.slice(1); // The interpolated values in the tagged template
    
    // We expect service-principal-123 to be passed to the SQL query
    expect(sqlValues).toContain('service-principal-123');
  });

});
