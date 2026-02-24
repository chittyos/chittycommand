# Phase 1: Bill Portal Scraping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand ChittyCommand to scrape login-based bill portals (Peoples Gas, ComEd, HOA, Xfinity, Citi, Home Depot, Lowe's) via ChittyRouter gateway, with credentials from ChittyConnect.

**Architecture:** ChittyCommand cron triggers scrape requests through ChittyRouter (unified gateway), which fetches portal credentials from ChittyConnect (1Password-backed), dispatches to ChittyScrape (Puppeteer browser automation), and returns structured results that ChittyCommand stores in cc_obligations + cc_documents + R2.

**Tech Stack:** Hono TypeScript (Cloudflare Workers), Puppeteer (@cloudflare/puppeteer), Neon PostgreSQL (Drizzle), R2 storage, 1Password via `op run`

**Repos touched:**
- `CHITTYOS/chittycommand` — orchestration, cron, storage
- `CHITTYOS/chittyrouter` — gateway routes, scrape-dispatch agent
- `CHITTYOS/chittyscrape` — portal scraper adapters
- `CHITTYOS/chittyconnect` — portal credential endpoint

---

## Task 1: Add `routerClient` to ChittyCommand integrations

**Files:**
- Modify: `chittycommand/src/index.ts:20-37` (add CHITTYROUTER_URL to Env)
- Modify: `chittycommand/src/lib/integrations.ts` (add routerClient after scrapeClient)
- Modify: `chittycommand/wrangler.toml` (add CHITTYROUTER_URL env var)

**Step 1: Add CHITTYROUTER_URL to Env type**

In `src/index.ts`, add to the Env type (after line 33):

```typescript
CHITTYROUTER_URL?: string;
```

**Step 2: Add routerClient to integrations.ts**

After the scrapeClient function (~line 499), add:

```typescript
// ── ChittyRouter ──────────────────────────────────────────────
// Unified ingestion gateway: routes scrape, court, and compliance requests

export interface RouterScrapeRequest {
  target: string;
  params?: Record<string, unknown>;
}

export interface RouterScrapeResponse {
  success: boolean;
  target: string;
  scraped_at: string;
  data?: Record<string, unknown>;
  artifacts?: { type: string; key: string; step: string }[];
  error?: string;
}

export function routerClient(env: Env) {
  const baseUrl = env.CHITTYROUTER_URL;
  if (!baseUrl) return null;

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000), // Portal scrapes can take longer
      });
      if (!res.ok) {
        console.error(`[router] ${path} failed: ${res.status}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[router] ${path} error:`, err);
      return null;
    }
  }

  return {
    scrapePortal: (request: RouterScrapeRequest) =>
      post<RouterScrapeResponse>('/route/scrape', request),

    scrapePortalBatch: (targets: RouterScrapeRequest[]) =>
      post<{ results: RouterScrapeResponse[] }>('/route/scrape/batch', { targets }),
  };
}
```

**Step 3: Add env var to wrangler.toml**

Add under `[vars]`:

```toml
CHITTYROUTER_URL = "https://router.chitty.cc"
```

**Step 4: Commit**

```bash
git add src/index.ts src/lib/integrations.ts wrangler.toml
git commit -m "feat: add routerClient for ChittyRouter gateway integration"
```

---

## Task 2: Add portal credential endpoint to ChittyConnect

**Files:**
- Create: `chittyconnect/src/routes/credentials-portal.ts`
- Modify: `chittyconnect/src/index.ts` (mount route)

**Step 1: Create credential route**

Create `chittyconnect/src/routes/credentials-portal.ts`:

```typescript
import { Hono } from 'hono';

const portalCredentials = new Hono();

/**
 * GET /api/credentials/portal/:target
 *
 * Returns ephemeral portal credentials from KV (populated by 1Password sync).
 * Credentials are never cached or logged — read from KV, return, done.
 *
 * Target format: "peoples_gas", "comed", "xfinity", "hoa:14-21-111-008-1006"
 */
portalCredentials.get('/:target', async (c) => {
  const target = c.req.param('target');
  const sourceService = c.req.header('X-Source-Service');

  // Only ChittyRouter should fetch portal credentials
  if (sourceService !== 'chittyrouter') {
    return c.json({ error: 'Unauthorized source service' }, 403);
  }

  const kvKey = `portal:${target}`;
  const raw = await c.env.CREDENTIALS_KV.get(kvKey);

  if (!raw) {
    return c.json({ error: `No credentials found for portal: ${target}` }, 404);
  }

  try {
    const creds = JSON.parse(raw);
    return c.json({
      target,
      credentials: creds,
      expires_in: 300, // hint: use within 5 minutes
    });
  } catch {
    return c.json({ error: 'Credential parse error' }, 500);
  }
});

export { portalCredentials };
```

**Step 2: Mount in ChittyConnect index**

In `chittyconnect/src/index.ts`, add the route mount (follow existing pattern for other routes):

```typescript
import { portalCredentials } from './routes/credentials-portal.js';

// After existing route mounts:
app.route('/api/credentials/portal', portalCredentials);
```

**Step 3: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyconnect
git add src/routes/credentials-portal.ts src/index.ts
git commit -m "feat: add portal credential endpoint for scraping pipeline"
```

---

## Task 3: Add `/route/scrape` endpoint to ChittyRouter

**Files:**
- Create: `chittyrouter/src/routes/scrape-router.js`
- Modify: `chittyrouter/src/index.ts` (mount route)

**Step 1: Create scrape router**

Create `chittyrouter/src/routes/scrape-router.js`:

```javascript
/**
 * Scrape Router — fetches credentials from ChittyConnect,
 * dispatches to ChittyScrape, returns structured results.
 *
 * POST /route/scrape
 * { target: "peoples_gas", params: { account_id: "..." } }
 */

export class ScrapeRouter {
  constructor(env) {
    this.env = env;
    this.connectUrl = env.CHITTYCONNECT_URL || 'https://connect.chitty.cc';
    this.scrapeUrl = env.CHITTYSCRAPE_URL || 'https://scrape.chitty.cc';
  }

  async handleScrape(request) {
    const { target, params } = request;

    if (!target) {
      return { success: false, error: 'Missing target' };
    }

    // Step 1: Fetch credentials from ChittyConnect
    let credentials;
    try {
      const credRes = await fetch(
        `${this.connectUrl}/api/credentials/portal/${encodeURIComponent(target)}`,
        {
          headers: {
            'X-Source-Service': 'chittyrouter',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(5000),
        }
      );

      if (!credRes.ok) {
        const err = await credRes.json().catch(() => ({}));
        return {
          success: false,
          target,
          error: `Credential fetch failed: ${credRes.status} ${err.error || ''}`,
        };
      }

      const credData = await credRes.json();
      credentials = credData.credentials;
    } catch (err) {
      return {
        success: false,
        target,
        error: `ChittyConnect unreachable: ${err.message}`,
      };
    }

    // Step 2: Dispatch to ChittyScrape with credentials
    try {
      const scrapeToken = await this.env.ROUTER_KV?.get('scrape:service_token') || '';

      const scrapeRes = await fetch(
        `${this.scrapeUrl}/api/scrape/portal/${encodeURIComponent(target)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${scrapeToken}`,
          },
          body: JSON.stringify({ credentials, params }),
          signal: AbortSignal.timeout(45000), // portal scrapes are slow
        }
      );

      if (!scrapeRes.ok) {
        return {
          success: false,
          target,
          error: `Scrape failed: ${scrapeRes.status}`,
        };
      }

      const result = await scrapeRes.json();
      return {
        success: true,
        target,
        scraped_at: new Date().toISOString(),
        ...result,
      };
    } catch (err) {
      return {
        success: false,
        target,
        error: `Scrape dispatch failed: ${err.message}`,
      };
    }
  }
}
```

**Step 2: Mount route in ChittyRouter**

In the main router file, add the `/route/scrape` endpoint:

```javascript
import { ScrapeRouter } from './routes/scrape-router.js';

// In the request handler:
app.post('/route/scrape', async (c) => {
  const body = await c.req.json();
  const router = new ScrapeRouter(c.env);
  const result = await router.handleScrape(body);
  return c.json(result);
});
```

**Step 3: Add env vars to ChittyRouter wrangler.toml**

```toml
CHITTYCONNECT_URL = "https://connect.chitty.cc"
CHITTYSCRAPE_URL = "https://scrape.chitty.cc"
```

**Step 4: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyrouter
git add src/routes/scrape-router.js src/index.ts wrangler.toml
git commit -m "feat: add /route/scrape endpoint for portal scraping gateway"
```

---

## Task 4: Add generic portal scraper base to ChittyScrape

**Files:**
- Create: `chittyscrape/src/scrapers/portal-base.ts`
- Create: `chittyscrape/src/routes/portal.ts`
- Modify: `chittyscrape/src/index.ts` (mount route)

**Step 1: Create PortalScraper base class**

Create `chittyscrape/src/scrapers/portal-base.ts`:

```typescript
import puppeteer from '@cloudflare/puppeteer';

export interface PortalCredentials {
  username: string;
  password: string;
  url?: string;           // override portal URL (for HOA portals)
  mfa_method?: string;    // "none", "email", "sms", "totp"
}

export interface ScrapeArtifact {
  type: 'screenshot' | 'pdf' | 'html';
  buffer: ArrayBuffer;
  step: string;           // "login", "dashboard", "statement"
}

export interface PortalScrapeResult {
  success: boolean;
  data?: Record<string, unknown>;
  artifacts: ScrapeArtifact[];
  error?: string;
}

/**
 * Base class for login-based portal scrapers.
 *
 * Subclasses implement:
 * - getLoginUrl(): target URL
 * - login(page, creds): perform login flow
 * - extractData(page): scrape structured data
 * - getStatements(page): optional PDF/statement download
 */
export abstract class PortalScraper {
  protected browser: any;
  protected page: any;
  protected artifacts: ScrapeArtifact[] = [];

  abstract getLoginUrl(): string;
  abstract login(page: any, creds: PortalCredentials): Promise<void>;
  abstract extractData(page: any): Promise<Record<string, unknown>>;

  async getStatements(_page: any): Promise<void> {
    // Optional override for statement download
  }

  async screenshot(step: string): Promise<void> {
    if (!this.page) return;
    const buffer = await this.page.screenshot({ fullPage: true });
    this.artifacts.push({ type: 'screenshot', buffer, step });
  }

  async scrape(browserBinding: Fetcher, creds: PortalCredentials): Promise<PortalScrapeResult> {
    this.artifacts = [];

    try {
      this.browser = await puppeteer.launch(browserBinding);
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });

      // Navigate to login
      const loginUrl = creds.url || this.getLoginUrl();
      await this.page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      await this.screenshot('pre-login');

      // Login
      await this.login(this.page, creds);
      await this.screenshot('post-login');

      // Extract data
      const data = await this.extractData(this.page);
      await this.screenshot('dashboard');

      // Optional: download statements
      await this.getStatements(this.page);

      return { success: true, data, artifacts: this.artifacts };
    } catch (err) {
      await this.screenshot('error').catch(() => {});
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        artifacts: this.artifacts,
      };
    } finally {
      await this.browser?.close().catch(() => {});
    }
  }
}
```

**Step 2: Create portal route handler**

Create `chittyscrape/src/routes/portal.ts`:

```typescript
import { Hono } from 'hono';
import type { PortalCredentials, PortalScrapeResult } from '../scrapers/portal-base';

// Import per-portal scrapers as they're built
// import { PeoplesGasScraper } from '../scrapers/peoples-gas';
// import { ComEdScraper } from '../scrapers/comed';

const portalRoutes = new Hono();

const scraperRegistry: Record<string, () => any> = {
  // Register scrapers here as they're built:
  // 'peoples_gas': () => new PeoplesGasScraper(),
  // 'comed': () => new ComEdScraper(),
};

/**
 * POST /api/scrape/portal/:target
 *
 * Receives credentials from ChittyRouter and runs the scraper.
 * Credentials are used in-memory and never persisted.
 */
portalRoutes.post('/:target', async (c) => {
  const target = c.req.param('target');
  const body = await c.req.json() as { credentials: PortalCredentials; params?: Record<string, unknown> };

  const factory = scraperRegistry[target];
  if (!factory) {
    return c.json({ success: false, error: `Unknown scrape target: ${target}` }, 400);
  }

  const scraper = factory();
  const result: PortalScrapeResult = await scraper.scrape(c.env.BROWSER, body.credentials);

  // Strip artifact buffers from response (they'd be stored in R2 by ChittyCommand)
  // For now, return metadata only
  const artifactMeta = result.artifacts.map((a) => ({
    type: a.type,
    step: a.step,
    size: a.buffer.byteLength,
  }));

  return c.json({
    success: result.success,
    data: result.data,
    artifacts: artifactMeta,
    error: result.error,
  });
});

export { portalRoutes };
```

**Step 3: Mount in ChittyScrape index**

```typescript
import { portalRoutes } from './routes/portal';

app.route('/api/scrape/portal', portalRoutes);
```

**Step 4: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyscrape
git add src/scrapers/portal-base.ts src/routes/portal.ts src/index.ts
git commit -m "feat: add PortalScraper base class and portal route handler"
```

---

## Task 5: Implement Peoples Gas scraper

**Files:**
- Create: `chittyscrape/src/scrapers/peoples-gas.ts`
- Modify: `chittyscrape/src/routes/portal.ts` (register scraper)

**Step 1: Create scraper**

Create `chittyscrape/src/scrapers/peoples-gas.ts`:

```typescript
import { PortalScraper, type PortalCredentials } from './portal-base';

export class PeoplesGasScraper extends PortalScraper {
  getLoginUrl(): string {
    return 'https://www.mypeoplesgas.com/login';
  }

  async login(page: any, creds: PortalCredentials): Promise<void> {
    // NOTE: Selectors need verification against live site
    await page.waitForSelector('#username, input[name="username"], input[type="email"]', { timeout: 10000 });
    await page.type('#username, input[name="username"], input[type="email"]', creds.username);
    await page.type('#password, input[name="password"], input[type="password"]', creds.password);
    await page.click('button[type="submit"], #loginBtn, .login-button');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  async extractData(page: any): Promise<Record<string, unknown>> {
    // NOTE: Selectors are placeholders — need verification against live mypeoplesgas.com
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      if (!doc) return {};

      const text = (sel: string): string => {
        const el = doc.querySelector(sel);
        return el ? (el.textContent || '').trim() : '';
      };

      const parseCurrency = (s: string): number => {
        const val = parseFloat(s.replace(/[$,]/g, ''));
        return isNaN(val) ? 0 : val;
      };

      // Try multiple selector patterns for balance
      const balanceText = text('.account-balance, .balance-amount, [data-testid="balance"]');
      const dueDateText = text('.due-date, .payment-due-date, [data-testid="due-date"]');

      return {
        balance: parseCurrency(balanceText),
        balance_raw: balanceText,
        due_date: dueDateText,
        account_number: text('.account-number, [data-testid="account-number"]'),
        last_payment_amount: parseCurrency(text('.last-payment-amount')),
        last_payment_date: text('.last-payment-date'),
      };
    });
  }
}
```

**Step 2: Register in portal routes**

In `chittyscrape/src/routes/portal.ts`, uncomment/add:

```typescript
import { PeoplesGasScraper } from '../scrapers/peoples-gas';

// In scraperRegistry:
'peoples_gas': () => new PeoplesGasScraper(),
```

**Step 3: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyscrape
git add src/scrapers/peoples-gas.ts src/routes/portal.ts
git commit -m "feat: add Peoples Gas portal scraper"
```

---

## Task 6: Implement ComEd scraper

**Files:**
- Create: `chittyscrape/src/scrapers/comed.ts`
- Modify: `chittyscrape/src/routes/portal.ts` (register)

**Step 1: Create scraper**

Create `chittyscrape/src/scrapers/comed.ts`:

```typescript
import { PortalScraper, type PortalCredentials } from './portal-base';

export class ComEdScraper extends PortalScraper {
  getLoginUrl(): string {
    return 'https://secure.comed.com/MyAccount/MyBillUsage/pages/secure/BillActivity.aspx';
  }

  async login(page: any, creds: PortalCredentials): Promise<void> {
    // NOTE: ComEd uses a multi-step login. Selectors need verification.
    await page.waitForSelector('#userId, input[name="userId"], input[type="email"]', { timeout: 10000 });
    await page.type('#userId, input[name="userId"], input[type="email"]', creds.username);
    await page.type('#password, input[name="password"]', creds.password);
    await page.click('#btnLogin, button[type="submit"], .sign-in-button');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  async extractData(page: any): Promise<Record<string, unknown>> {
    // NOTE: Selectors are placeholders — need verification against live comed.com
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      if (!doc) return {};

      const text = (sel: string): string => {
        const el = doc.querySelector(sel);
        return el ? (el.textContent || '').trim() : '';
      };

      const parseCurrency = (s: string): number => {
        const val = parseFloat(s.replace(/[$,]/g, ''));
        return isNaN(val) ? 0 : val;
      };

      const balanceText = text('.total-amount-due, .balance-due, [data-testid="balance"]');
      const dueDateText = text('.due-date, .payment-due-date, [data-testid="due-date"]');

      // Try to get usage data
      const usageText = text('.usage-amount, .kwh-usage, [data-testid="usage"]');

      return {
        balance: parseCurrency(balanceText),
        balance_raw: balanceText,
        due_date: dueDateText,
        account_number: text('.account-number, [data-testid="account-number"]'),
        usage_kwh: usageText,
        service_address: text('.service-address'),
        last_payment_amount: parseCurrency(text('.last-payment')),
        last_payment_date: text('.last-payment-date'),
      };
    });
  }
}
```

**Step 2: Register in portal routes**

```typescript
import { ComEdScraper } from '../scrapers/comed';

'comed': () => new ComEdScraper(),
```

**Step 3: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyscrape
git add src/scrapers/comed.ts src/routes/portal.ts
git commit -m "feat: add ComEd portal scraper"
```

---

## Task 7: Wire utility_scrape cron in ChittyCommand

**Files:**
- Modify: `chittycommand/src/lib/cron.ts` (add syncUtilities function, wire to cron)
- Modify: `chittycommand/src/lib/integrations.ts:3` (import routerClient)

**Step 1: Add routerClient import to cron.ts**

In `src/lib/cron.ts`, line 3, add `routerClient` to imports:

```typescript
import { plaidClient, financeClient, mercuryClient, scrapeClient, routerClient } from './integrations';
```

**Step 2: Add syncUtilities function**

After `syncMonthlyChecks` (~line 471), add:

```typescript
/**
 * Scrape utility portals via ChittyRouter gateway.
 * Each portal scrape is independent — failures don't block others.
 */
export async function syncUtilities(env: Env, sql: NeonQueryFunction<false, false>): Promise<number> {
  const router = routerClient(env);
  if (!router) return 0;

  const targets = ['peoples_gas', 'comed'];
  let synced = 0;

  for (const target of targets) {
    try {
      const result = await router.scrapePortal({ target });
      if (!result?.success || !result.data) {
        console.error(`[cron:utility_scrape] ${target} failed:`, result?.error);
        continue;
      }

      // Upsert obligation from scraped data
      const balance = Number(result.data.balance) || 0;
      const dueDate = result.data.due_date as string | undefined;

      if (balance > 0) {
        const [existing] = await sql`
          SELECT id FROM cc_obligations WHERE payee ILIKE ${`%${target.replace('_', ' ')}%`} AND status != 'paid'
        `;

        if (existing) {
          await sql`
            UPDATE cc_obligations
            SET amount_due = ${balance},
                due_date = ${dueDate || null},
                metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_scrape}', ${JSON.stringify(result.data)}::jsonb),
                updated_at = NOW()
            WHERE id = ${existing.id}
          `;
        } else {
          await sql`
            INSERT INTO cc_obligations (payee, category, amount_due, due_date, status, source, metadata)
            VALUES (${target.replace('_', ' ')}, 'utilities', ${balance}, ${dueDate || null}, 'pending', 'portal_scrape',
                    ${JSON.stringify({ scrape_target: target, last_scrape: result.data })}::jsonb)
          `;
        }
        synced++;
      }

      // Log the scrape as a document (available for evidence elevation)
      await sql`
        INSERT INTO cc_documents (doc_type, source, filename, content_text, metadata, processing_status)
        VALUES ('portal_scrape', ${target}, ${`${target}_${new Date().toISOString().split('T')[0]}.json`},
                ${JSON.stringify(result.data)}, ${JSON.stringify({ scraped_at: result.scraped_at, artifacts: result.artifacts })}::jsonb, 'pending')
      `;
    } catch (err) {
      console.error(`[cron:utility_scrape] ${target} error:`, err);
    }
  }

  return synced;
}
```

**Step 3: Wire into cron handler**

In the `runCronSync` function, after the `monthly_check` block (~line 103), add:

```typescript
    if (source === 'utility_scrape') {
      try {
        recordsSynced += await syncUtilities(env, sql);
      } catch (err) {
        console.error('[cron:utility_scrape] failed:', err);
      }
    }
```

**Step 4: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand
git add src/lib/cron.ts src/lib/integrations.ts
git commit -m "feat: wire utility portal scraping into cron pipeline via ChittyRouter"
```

---

## Task 8: Add remaining portal scrapers (HOA, Xfinity, Citi, Home Depot, Lowe's)

**Files:**
- Create: `chittyscrape/src/scrapers/xfinity.ts`
- Create: `chittyscrape/src/scrapers/citi.ts`
- Create: `chittyscrape/src/scrapers/home-depot.ts`
- Create: `chittyscrape/src/scrapers/lowes.ts`
- Create: `chittyscrape/src/scrapers/hoa.ts`
- Modify: `chittyscrape/src/routes/portal.ts` (register all)

Each scraper follows the same pattern as Tasks 5-6. The key differences:

| Scraper | Login URL | Notes |
|---------|-----------|-------|
| `XfinityScraper` | `xfinity.com/billing` | Uses OAuth-style login |
| `CitiScraper` | `citicards.com` | Multi-step auth, statement download |
| `HomeDepotScraper` | `homedepot.com/myaccount` | Standard login |
| `LowesScraper` | `lowes.com/mylowes` | Standard login |
| `HOAScraper` | Configurable via `creds.url` | Per-property portal, URL from credentials |

**Step 1: Create each scraper file following the PortalScraper pattern**

Each file: extend `PortalScraper`, implement `getLoginUrl()`, `login()`, `extractData()`.

NOTE: All CSS selectors are placeholders. Each scraper needs manual verification against the live portal. This is expected — scraper selectors are always fragile and need periodic maintenance.

**Step 2: Register all in portal.ts**

```typescript
import { XfinityScraper } from '../scrapers/xfinity';
import { CitiScraper } from '../scrapers/citi';
import { HomeDepotScraper } from '../scrapers/home-depot';
import { LowesScraper } from '../scrapers/lowes';
import { HOAScraper } from '../scrapers/hoa';

const scraperRegistry: Record<string, () => any> = {
  'peoples_gas': () => new PeoplesGasScraper(),
  'comed': () => new ComEdScraper(),
  'xfinity': () => new XfinityScraper(),
  'citi': () => new CitiScraper(),
  'home_depot': () => new HomeDepotScraper(),
  'lowes': () => new LowesScraper(),
  'hoa': () => new HOAScraper(),
};
```

**Step 3: Expand syncUtilities targets in ChittyCommand**

Update the targets array in `syncUtilities()` and add separate cron entries for credit cards and HOA:

```typescript
// In cron.ts, add handlers for credit_scrape and hoa_scrape:
if (source === 'credit_scrape') {
  // targets: ['citi', 'home_depot', 'lowes']
}

if (source === 'hoa_scrape') {
  // targets: ['hoa:14-21-111-008-1006', 'hoa:14-28-122-017-1180', ...]
}
```

Add cron entries to the schedule map:

```typescript
'0 14 1 * *': 'credit_scrape',   // 8 AM CT 1st of month
'0 15 1 * *': 'hoa_scrape',      // 9 AM CT 1st of month
```

**Step 4: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyscrape
git add src/scrapers/ src/routes/portal.ts
git commit -m "feat: add Xfinity, Citi, Home Depot, Lowe's, HOA portal scrapers"

cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand
git add src/lib/cron.ts
git commit -m "feat: add credit and HOA scrape cron jobs"
```

---

## Task 9: Add bridge route for manual scrape trigger

**Files:**
- Modify: `chittycommand/src/routes/bridge.ts` (add portal scrape routes)

**Step 1: Add portal scrape bridge routes**

After existing scrape bridge routes in `bridge.ts`, add:

```typescript
/** Trigger a portal scrape via ChittyRouter */
bridgeRoutes.post('/scrape/portal/:target', async (c) => {
  const router = routerClient(c.env);
  if (!router) return c.json({ error: 'ChittyRouter not configured' }, 503);

  const target = c.req.param('target');
  const params = await c.req.json().catch(() => ({}));

  const result = await router.scrapePortal({ target, params });
  if (!result) return c.json({ error: 'Scrape request failed' }, 502);

  return c.json(result);
});

/** Trigger batch portal scrape */
bridgeRoutes.post('/scrape/portal-batch', async (c) => {
  const router = routerClient(c.env);
  if (!router) return c.json({ error: 'ChittyRouter not configured' }, 503);

  const { targets } = await c.req.json() as { targets: string[] };
  const requests = targets.map((target) => ({ target }));
  const result = await router.scrapePortalBatch(requests);

  return c.json(result || { error: 'Batch scrape failed' });
});
```

**Step 2: Add routerClient import to bridge.ts**

```typescript
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient, booksClient, assetsClient, scrapeClient, routerClient } from '../lib/integrations';
```

**Step 3: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand
git add src/routes/bridge.ts
git commit -m "feat: add manual portal scrape bridge routes via ChittyRouter"
```

---

## Task 10: Add Settings UI sync buttons for portal scrapes

**Files:**
- Modify: `chittycommand/ui/src/pages/Settings.tsx` (add portal sync buttons)
- Modify: `chittycommand/ui/src/lib/api.ts` (add scrapePortal method)

**Step 1: Add API method**

In `ui/src/lib/api.ts`, add to the api object:

```typescript
scrapePortal: (target: string) =>
  fetchJson<{ success: boolean; data?: Record<string, unknown>; error?: string }>(
    `/api/bridge/scrape/portal/${target}`, { method: 'POST' }
  ),
```

**Step 2: Add sync buttons to Settings.tsx**

In the Bridge Sync Controls card, add portal scrape buttons:

```typescript
<BridgeSyncButton
  label="Peoples Gas"
  syncing={bridgeSyncing === 'Peoples Gas'}
  onClick={() => runBridgeSync('Peoples Gas', () => api.scrapePortal('peoples_gas'))}
/>
<BridgeSyncButton
  label="ComEd"
  syncing={bridgeSyncing === 'ComEd'}
  onClick={() => runBridgeSync('ComEd', () => api.scrapePortal('comed'))}
/>
<BridgeSyncButton
  label="Xfinity"
  syncing={bridgeSyncing === 'Xfinity'}
  onClick={() => runBridgeSync('Xfinity', () => api.scrapePortal('xfinity'))}
/>
```

**Step 3: Commit**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand
git add ui/src/pages/Settings.tsx ui/src/lib/api.ts
git commit -m "feat: add portal scrape sync buttons to Settings UI"
```

---

## Build & Deploy Sequence

After all tasks are complete:

1. Deploy ChittyConnect first (credential endpoint)
2. Deploy ChittyScrape second (portal scrapers)
3. Deploy ChittyRouter third (gateway routes)
4. Deploy ChittyCommand last (cron wiring + UI)
5. Populate portal credentials in 1Password vault, sync to ChittyConnect KV
6. Test manually via Settings UI sync buttons
7. Verify cron triggers work on next scheduled run
