# ChittyScrape + ChittyFinance Liabilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a browser automation scraper service (ChittyScrape), extend ChittyFinance with liability account support, and wire scrape results into ChittyCommand's cron pipeline.

**Architecture:** ChittyScrape is a Cloudflare Worker with Browser Rendering that scrapes Mr. Cooper, Cook County tax, and court docket pages. Results push to ChittyFinance (liabilities) and ChittyLedger (legal). ChittyCommand orchestrates scrapes via cron and reads results for its dashboard.

**Tech Stack:** Hono TypeScript, @cloudflare/puppeteer, Cloudflare Workers Browser Rendering, Neon PostgreSQL, Express (ChittyFinance)

---

## Phase 1: Fix ChittyFinance

### Task 1: Clone ChittyFinance and diagnose API issues

**Files:**
- Read: `server/routes.ts`, `server/index.ts`, `server/db.ts`
- Read: `database/system.schema.ts`
- Read: `.replit`, `package.json`

**Step 1: Clone the repo**

```bash
cd /Users/nb/Desktop/Projects/github.com/chittyapps
git clone git@github.com:chittyapps/chittyfinance.git
cd chittyfinance
```

**Step 2: Install dependencies**

```bash
pnpm install
```

**Step 3: Check environment**

```bash
cp .env.example .env
# Fill in DATABASE_URL from 1Password: op read "op://Private/ChittyFinance Neon/connection_string"
```

**Step 4: Start dev server and test endpoints**

```bash
pnpm dev
curl -s http://localhost:5000/health
curl -s http://localhost:5000/api/accounts
```

Document which endpoints return errors and why. The deployed version returns 1101 (Worker execution error) on `/api/accounts`.

**Step 5: Commit any diagnostic notes**

No code changes yet — just understanding the codebase.

---

### Task 2: Add liability account types to ChittyFinance

**Files:**
- Modify: `database/system.schema.ts` (add `liabilityDetails` column to accounts)
- Create: migration SQL for the new column

**Step 1: Add liabilityDetails to accounts schema**

In `database/system.schema.ts`, add to the `accounts` table definition after `metadata`:

```typescript
  liabilityDetails: jsonb('liability_details'),
  // For mortgage: {interestRate, escrowBalance, payoffAmount, maturityDate, lender, monthlyPayment}
  // For tax: {taxYear, pin, installments: [{number, amount, dueDate, status}], exemptions}
```

The `accounts.type` field is already free-text. Liability types use: `'mortgage'`, `'loan'`, `'tax_liability'`.

**Step 2: Generate and run migration**

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit push
```

**Step 3: Verify the column exists**

```bash
# Connect to Neon and check
psql $DATABASE_URL -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'liability_details';"
```

Expected: `liability_details | jsonb`

**Step 4: Commit**

```bash
git add database/system.schema.ts drizzle/
git commit -m "feat: add liability_details column to accounts for mortgage/tax data"
```

---

### Task 3: Add liability account API endpoints to ChittyFinance

**Files:**
- Modify: `server/routes.ts` (add liability endpoints in the accounts section)

**Step 1: Add POST /api/accounts/liability endpoint**

Find the accounts section in `server/routes.ts` and add:

```typescript
// Create or update a liability account (mortgage, loan, tax)
app.post("/api/accounts/liability", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const body = z.object({
      tenantId: z.string().uuid(),
      name: z.string().min(1),
      type: z.enum(['mortgage', 'loan', 'tax_liability']),
      institution: z.string().optional(),
      balance: z.string(), // decimal as string
      externalId: z.string().optional(),
      liabilityDetails: z.record(z.unknown()).optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    // Upsert by externalId if provided
    if (body.externalId) {
      const [existing] = await db
        .select()
        .from(schema.accounts)
        .where(and(
          eq(schema.accounts.externalId, body.externalId),
          eq(schema.accounts.tenantId, body.tenantId)
        ));

      if (existing) {
        const [updated] = await db
          .update(schema.accounts)
          .set({
            balance: body.balance,
            liabilityDetails: body.liabilityDetails,
            metadata: body.metadata,
            updatedAt: new Date(),
          })
          .where(eq(schema.accounts.id, existing.id))
          .returning();
        return res.json(updated);
      }
    }

    const [account] = await db
      .insert(schema.accounts)
      .values({
        tenantId: body.tenantId,
        name: body.name,
        type: body.type,
        institution: body.institution,
        balance: body.balance,
        externalId: body.externalId,
        liabilityDetails: body.liabilityDetails,
        metadata: body.metadata,
      })
      .returning();

    res.status(201).json(account);
  } catch (err: any) {
    console.error('[liability] create error:', err);
    res.status(err.issues ? 400 : 500).json({ error: err.message || 'Internal error' });
  }
});
```

**Step 2: Add GET /api/accounts?type=mortgage filter**

Ensure the existing GET `/api/accounts` route supports filtering by type. If not, add a query param:

```typescript
// In the existing GET /api/accounts handler, add type filter:
const typeFilter = req.query.type as string | undefined;
const conditions = [eq(schema.accounts.tenantId, tenantId)];
if (typeFilter) conditions.push(eq(schema.accounts.type, typeFilter));
```

**Step 3: Add POST /api/accounts/:id/sync endpoint**

```typescript
// Sync/update an account from external source (scraper, API)
app.post("/api/accounts/:id/sync", serviceAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = z.object({
      balance: z.string().optional(),
      liabilityDetails: z.record(z.unknown()).optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.balance !== undefined) updates.balance = body.balance;
    if (body.liabilityDetails !== undefined) updates.liabilityDetails = body.liabilityDetails;
    if (body.metadata !== undefined) updates.metadata = body.metadata;

    const [updated] = await db
      .update(schema.accounts)
      .set(updates)
      .where(eq(schema.accounts.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Account not found' });
    res.json(updated);
  } catch (err: any) {
    console.error('[sync] error:', err);
    res.status(err.issues ? 400 : 500).json({ error: err.message || 'Internal error' });
  }
});
```

Note: `serviceAuth` is the middleware for service-to-service calls (vs `isAuthenticated` for user auth). Check which middleware ChittyFinance uses for inter-service calls.

**Step 4: Test locally**

```bash
# Create a test liability account
curl -X POST http://localhost:5000/api/accounts/liability \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"YOUR_TENANT_ID","name":"Mr. Cooper - 541 W Addison","type":"mortgage","institution":"Mr. Cooper","balance":"180000.00","externalId":"mrcooper-addison","liabilityDetails":{"interestRate":3.5,"escrowBalance":1200}}'
```

**Step 5: Commit**

```bash
git add server/routes.ts
git commit -m "feat: add liability account endpoints (create, sync, type filter)"
```

---

### Task 4: Fix ChittyFinance API stability and deploy

**Files:**
- Depends on diagnosis from Task 1

**Step 1: Fix identified issues from Task 1**

Address the 1101 errors found during diagnosis. Common causes:
- Missing environment variables on Replit
- Database connection issues
- Middleware errors on unauthenticated routes

**Step 2: Deploy to Replit**

```bash
git push origin main
# Replit auto-deploys from main
```

**Step 3: Verify deployed endpoints**

```bash
curl -s https://finance.chitty.cc/health
curl -s https://finance.chitty.cc/api/accounts
curl -s -X POST https://finance.chitty.cc/api/accounts/liability -H "Content-Type: application/json" -d '{...}'
```

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: stabilize API, fix 1101 errors on account endpoints"
```

---

### Task 5: Seed liability accounts in ChittyFinance

**Files:**
- No code changes — data seeding via API calls

**Step 1: Identify or create tenant for properties**

```bash
curl -s https://finance.chitty.cc/api/tenants | jq .
```

If no tenant exists for personal properties, create one.

**Step 2: Seed mortgage account (Addison only)**

```bash
curl -X POST https://finance.chitty.cc/api/accounts/liability \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "TENANT_ID",
    "name": "Mr. Cooper - 541 W Addison",
    "type": "mortgage",
    "institution": "Mr. Cooper",
    "balance": "0",
    "externalId": "mrcooper-addison-3s",
    "liabilityDetails": {"lender": "USAA origin, serviced by Mr. Cooper", "address": "541 W Addison St #3S"},
    "metadata": {"pin": "14-21-111-008-1006"}
  }'
```

**Step 3: Seed tax liability accounts (4 properties)**

```bash
for pin_data in \
  '14-21-111-008-1006|541 W Addison St #3S' \
  '14-28-122-017-1180|550 W Surf St C-211' \
  '14-28-122-017-1091|559 W Surf St C-504' \
  '14-16-300-032-1238|4343 N Clarendon Ave #1610'; do
  IFS='|' read -r pin addr <<< "$pin_data"
  curl -X POST https://finance.chitty.cc/api/accounts/liability \
    -H "Content-Type: application/json" \
    -d "{\"tenantId\":\"TENANT_ID\",\"name\":\"Cook County Tax - ${addr}\",\"type\":\"tax_liability\",\"institution\":\"Cook County Treasurer\",\"balance\":\"0\",\"externalId\":\"cookcounty-${pin}\",\"liabilityDetails\":{\"pin\":\"${pin}\",\"address\":\"${addr}\"}}"
done
```

---

## Phase 2: Build ChittyScrape

### Task 6: Scaffold ChittyScrape repo

**Files:**
- Create: `CHITTYOS/chittyscrape/` (new repo)
- Create: `src/index.ts`, `wrangler.toml`, `package.json`, `tsconfig.json`

**Step 1: Create repo on GitHub**

```bash
gh repo create CHITTYOS/chittyscrape --public --description "Browser automation scraper service for ChittyOS"
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS
git clone git@github.com:CHITTYOS/chittyscrape.git
cd chittyscrape
```

**Step 2: Initialize project**

```bash
npm init -y
npm install hono @cloudflare/puppeteer
npm install -D typescript @cloudflare/workers-types wrangler
```

**Step 3: Create wrangler.toml**

```toml
name = "chittyscrape"
main = "src/index.ts"
compatibility_date = "2026-01-15"
compatibility_flags = ["nodejs_compat"]
routes = [{ pattern = "scrape.chitty.cc", custom_domain = true }]

[browser]
binding = "BROWSER"

[[kv_namespaces]]
binding = "SCRAPE_KV"
id = "PLACEHOLDER"

[[tail_consumers]]
service = "chittytrack"
```

Note: Create the KV namespace first: `npx wrangler kv namespace create SCRAPE_KV`

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**Step 5: Create src/index.ts (entry point with health + auth)**

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  BROWSER: any; // Cloudflare Browser Rendering
  SCRAPE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: ['https://command.chitty.cc'], allowHeaders: ['Authorization', 'Content-Type'] }));

// Auth middleware — service token
app.use('/api/*', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Auth required' }, 401);
  const token = auth.slice(7);
  const valid = await c.env.SCRAPE_KV.get('scrape:service_token');
  if (!valid || token !== valid) return c.json({ error: 'Invalid token' }, 403);
  return next();
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'chittyscrape', timestamp: new Date().toISOString() }));

// Scraper routes will be added in subsequent tasks
// app.post('/api/scrape/court-docket', ...)
// app.post('/api/scrape/cook-county-tax', ...)
// app.post('/api/scrape/mr-cooper', ...)

export default { fetch: app.fetch };
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold ChittyScrape service with Hono + Browser Rendering"
```

---

### Task 7: Implement court docket scraper

**Files:**
- Create: `src/scrapers/court-docket.ts`
- Modify: `src/index.ts` (add route)

**Step 1: Create court docket scraper**

Create `src/scrapers/court-docket.ts`:

```typescript
import puppeteer from '@cloudflare/puppeteer';

interface DocketEntry {
  date: string;
  description: string;
  filedBy?: string;
}

interface DocketResult {
  success: boolean;
  data?: {
    caseNumber: string;
    parties?: string;
    judge?: string;
    status?: string;
    entries: DocketEntry[];
    nextHearing?: string;
  };
  error?: string;
}

export async function scrapeCookCountyDocket(browser: any, caseNumber: string): Promise<DocketResult> {
  let page: any;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to Cook County Circuit Clerk case search
    await page.goto('https://casesearch.cookcountyclerkofcourt.org/CivilCaseSearchAPI/api/CivilCases', {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    // The Cook County Clerk site has a case search form
    // Try the direct case lookup URL pattern
    await page.goto(`https://casesearch.cookcountyclerkofcourt.org/CivilCaseSearchAPI/api/CivilCases/${caseNumber}`, {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    // Parse the response — Cook County may return JSON or HTML
    const content = await page.content();

    // Try to extract JSON if the API returns it
    const bodyText = await page.evaluate(() => document.body?.innerText || '');

    let caseData: any;
    try {
      caseData = JSON.parse(bodyText);
    } catch {
      // If not JSON, parse HTML
      caseData = null;
    }

    if (caseData) {
      const entries: DocketEntry[] = (caseData.activities || caseData.docketEntries || []).map((e: any) => ({
        date: e.activityDate || e.date || '',
        description: e.activityDescription || e.description || '',
        filedBy: e.filedBy || undefined,
      }));

      return {
        success: true,
        data: {
          caseNumber,
          parties: caseData.caseTitle || caseData.parties || undefined,
          judge: caseData.judgeName || caseData.judge || undefined,
          status: caseData.caseStatus || caseData.status || undefined,
          entries,
          nextHearing: caseData.nextCourtDate || caseData.nextHearing || undefined,
        },
      };
    }

    // Fallback: scrape HTML page structure
    // This section needs to be adapted to the actual page structure
    // after testing against the live site
    return {
      success: false,
      error: 'Could not parse case data — HTML scraping fallback needed',
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
```

**Step 2: Wire into index.ts**

Add to `src/index.ts` before the export:

```typescript
import { scrapeCookCountyDocket } from './scrapers/court-docket';
import puppeteer from '@cloudflare/puppeteer';

app.post('/api/scrape/court-docket', async (c) => {
  const { caseNumber } = await c.req.json() as { caseNumber: string };
  if (!caseNumber) return c.json({ error: 'caseNumber required' }, 400);

  const browser = await puppeteer.launch(c.env.BROWSER);
  try {
    const result = await scrapeCookCountyDocket(browser, caseNumber);
    return c.json(result);
  } finally {
    await browser.close();
  }
});
```

**Step 3: Test locally (limited — Browser Rendering only works deployed)**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/scrapers/court-docket.ts src/index.ts
git commit -m "feat: add Cook County court docket scraper"
```

---

### Task 8: Implement Cook County tax scraper

**Files:**
- Create: `src/scrapers/cook-county-tax.ts`
- Modify: `src/index.ts` (add route)

**Step 1: Create tax scraper**

Create `src/scrapers/cook-county-tax.ts`:

```typescript
import puppeteer from '@cloudflare/puppeteer';

interface TaxInstallment {
  number: number;
  amount: number;
  dueDate: string;
  status: string; // 'paid', 'unpaid', 'partial'
}

interface TaxResult {
  success: boolean;
  data?: {
    pin: string;
    address?: string;
    taxYear: number;
    installments: TaxInstallment[];
    totalTax: number;
    exemptions?: string[];
  };
  error?: string;
}

export async function scrapeCookCountyTax(browser: any, pin: string): Promise<TaxResult> {
  let page: any;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Cook County Treasurer payment status page
    // URL format: https://cookcountytreasurer.com/paymenthistory.aspx
    await page.goto('https://cookcountytreasurer.com/setsearchparameters.aspx', {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    // Enter PIN in search
    // The PIN format is XX-XX-XXX-XXX-XXXX — may need to strip dashes
    const cleanPin = pin.replace(/-/g, '');

    // Type PIN into search field
    await page.type('#ContentPlaceHolder1_ASPxRoundPanel1_SearchByPIN_txtPIN', cleanPin, { delay: 50 });

    // Click search button
    await page.click('#ContentPlaceHolder1_ASPxRoundPanel1_SearchByPIN_btnSearchPIN');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });

    // Parse the tax bill details from the results page
    // This needs to be adapted to the actual page structure
    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('.tax-detail-row, tr.tax-row');
      const installments: any[] = [];

      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          installments.push({
            amount: parseFloat(cells[1]?.textContent?.replace(/[$,]/g, '') || '0'),
            dueDate: cells[2]?.textContent?.trim() || '',
            status: cells[3]?.textContent?.trim()?.toLowerCase() || 'unpaid',
          });
        }
      });

      const totalEl = document.querySelector('.total-tax, #total-amount');
      const addressEl = document.querySelector('.property-address, #address');
      const yearEl = document.querySelector('.tax-year, #year');

      return {
        address: addressEl?.textContent?.trim() || undefined,
        taxYear: parseInt(yearEl?.textContent?.trim() || new Date().getFullYear().toString()),
        installments,
        totalTax: parseFloat(totalEl?.textContent?.replace(/[$,]/g, '') || '0'),
      };
    });

    return {
      success: true,
      data: {
        pin,
        address: data.address,
        taxYear: data.taxYear,
        installments: data.installments.map((inst: any, i: number) => ({
          number: i + 1,
          amount: inst.amount,
          dueDate: inst.dueDate,
          status: inst.status,
        })),
        totalTax: data.totalTax,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
```

**Step 2: Wire into index.ts**

```typescript
import { scrapeCookCountyTax } from './scrapers/cook-county-tax';

app.post('/api/scrape/cook-county-tax', async (c) => {
  const { pin } = await c.req.json() as { pin: string };
  if (!pin) return c.json({ error: 'pin required' }, 400);

  const browser = await puppeteer.launch(c.env.BROWSER);
  try {
    const result = await scrapeCookCountyTax(browser, pin);
    return c.json(result);
  } finally {
    await browser.close();
  }
});
```

**Step 3: Verify compiles**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/scrapers/cook-county-tax.ts src/index.ts
git commit -m "feat: add Cook County property tax scraper"
```

---

### Task 9: Implement Mr. Cooper scraper

**Files:**
- Create: `src/scrapers/mr-cooper.ts`
- Modify: `src/index.ts` (add route)

**Step 1: Create Mr. Cooper scraper**

Create `src/scrapers/mr-cooper.ts`:

```typescript
import puppeteer from '@cloudflare/puppeteer';

interface PaymentHistoryEntry {
  date: string;
  amount: number;
  principal?: number;
  interest?: number;
  escrow?: number;
}

interface MrCooperResult {
  success: boolean;
  data?: {
    property: string;
    currentBalance: number;
    monthlyPayment: number;
    escrowBalance: number;
    interestRate: number;
    payoffAmount?: number;
    nextPaymentDate?: string;
    paymentHistory: PaymentHistoryEntry[];
  };
  error?: string;
}

export async function scrapeMrCooper(
  browser: any,
  credentials: { username: string; password: string },
  property: string
): Promise<MrCooperResult> {
  let page: any;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to Mr. Cooper login
    await page.goto('https://www.mrcooper.com/servicing/login', {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    // Login
    await page.type('#username, input[name="username"], input[type="email"]', credentials.username, { delay: 30 });
    await page.type('#password, input[name="password"], input[type="password"]', credentials.password, { delay: 30 });
    await page.click('button[type="submit"], #loginButton');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 });

    // Check for login failure
    const errorEl = await page.$('.error-message, .login-error');
    if (errorEl) {
      const errorText = await page.evaluate((el: any) => el.textContent, errorEl);
      return { success: false, error: `Login failed: ${errorText}` };
    }

    // Navigate to loan details / dashboard
    // Mr. Cooper's dashboard typically shows loan summary on the main page after login
    await page.waitForSelector('.loan-summary, .account-overview, [data-testid="loan-balance"]', { timeout: 15000 });

    // Extract mortgage data
    const data = await page.evaluate(() => {
      const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';
      const getNum = (sel: string) => {
        const text = getText(sel);
        return parseFloat(text.replace(/[$,]/g, '')) || 0;
      };

      return {
        currentBalance: getNum('.loan-balance, .principal-balance, [data-testid="loan-balance"]'),
        monthlyPayment: getNum('.monthly-payment, .payment-amount, [data-testid="payment-amount"]'),
        escrowBalance: getNum('.escrow-balance, [data-testid="escrow-balance"]'),
        interestRate: parseFloat(getText('.interest-rate, [data-testid="interest-rate"]').replace('%', '')) || 0,
        nextPaymentDate: getText('.next-payment-date, [data-testid="next-payment-date"]'),
      };
    });

    // Try to navigate to payment history
    const paymentHistory: PaymentHistoryEntry[] = [];
    try {
      const historyLink = await page.$('a[href*="payment-history"], a[href*="activity"]');
      if (historyLink) {
        await historyLink.click();
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });

        const history = await page.evaluate(() => {
          const rows = document.querySelectorAll('.payment-row, tr.history-row, [data-testid="payment-entry"]');
          return Array.from(rows).slice(0, 12).map((row: any) => {
            const cells = row.querySelectorAll('td, .cell');
            return {
              date: cells[0]?.textContent?.trim() || '',
              amount: parseFloat(cells[1]?.textContent?.replace(/[$,]/g, '') || '0'),
              principal: parseFloat(cells[2]?.textContent?.replace(/[$,]/g, '') || '0') || undefined,
              interest: parseFloat(cells[3]?.textContent?.replace(/[$,]/g, '') || '0') || undefined,
              escrow: parseFloat(cells[4]?.textContent?.replace(/[$,]/g, '') || '0') || undefined,
            };
          });
        });
        paymentHistory.push(...history);
      }
    } catch {
      // Payment history is best-effort
    }

    return {
      success: true,
      data: {
        property,
        currentBalance: data.currentBalance,
        monthlyPayment: data.monthlyPayment,
        escrowBalance: data.escrowBalance,
        interestRate: data.interestRate,
        nextPaymentDate: data.nextPaymentDate || undefined,
        paymentHistory,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
```

**Step 2: Wire into index.ts**

```typescript
import { scrapeMrCooper } from './scrapers/mr-cooper';

app.post('/api/scrape/mr-cooper', async (c) => {
  const { property } = await c.req.json() as { property: string };
  if (!property) return c.json({ error: 'property required' }, 400);

  // Get credentials from KV
  const username = await c.env.SCRAPE_KV.get('mrcooper:username');
  const password = await c.env.SCRAPE_KV.get('mrcooper:password');
  if (!username || !password) return c.json({ error: 'Mr. Cooper credentials not configured' }, 503);

  const browser = await puppeteer.launch(c.env.BROWSER);
  try {
    const result = await scrapeMrCooper(browser, { username, password }, property);
    return c.json(result);
  } finally {
    await browser.close();
  }
});
```

**Step 3: Verify compiles**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/scrapers/mr-cooper.ts src/index.ts
git commit -m "feat: add Mr. Cooper mortgage portal scraper"
```

---

### Task 10: Deploy ChittyScrape and seed credentials

**Files:**
- No code changes — deploy + KV seeding

**Step 1: Create KV namespace**

```bash
npx wrangler kv namespace create SCRAPE_KV
# Update wrangler.toml with the returned ID
```

**Step 2: Deploy**

```bash
npx wrangler deploy
```

**Step 3: Seed service token**

```bash
token=$(openssl rand -hex 32)
op item edit o2kqh2xksm7crq6a6pvmddctre "ChittyScrape.service_token=${token}" --vault Private > /dev/null 2>&1
npx wrangler kv key put --binding SCRAPE_KV --remote "scrape:service_token" "${token}"
```

**Step 4: Seed Mr. Cooper credentials**

```bash
# Get Mr. Cooper creds from 1Password
mrcooper_user=$(op read "op://Private/Mr Cooper/username")
mrcooper_pass=$(op read "op://Private/Mr Cooper/password")
npx wrangler kv key put --binding SCRAPE_KV --remote "mrcooper:username" "${mrcooper_user}"
npx wrangler kv key put --binding SCRAPE_KV --remote "mrcooper:password" "${mrcooper_pass}"
```

**Step 5: Verify health**

```bash
curl -s https://scrape.chitty.cc/health | jq .
```

**Step 6: Test court docket scrape**

```bash
token=$(op read "op://Private/Mercury API Keys/ChittyScrape/service_token")
curl -s -X POST https://scrape.chitty.cc/api/scrape/court-docket \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d '{"caseNumber": "2024D007847"}'
```

**Step 7: Push to GitHub**

```bash
git push origin main
```

---

## Phase 3: Wire into ChittyCommand

### Task 11: Add ChittyScrape client to ChittyCommand integrations

**Files:**
- Modify: `src/lib/integrations.ts` (add `scrapeClient`)
- Modify: `src/index.ts` (add `CHITTYSCRAPE_URL` to Env)
- Modify: `wrangler.toml` (add env var)

**Step 1: Add CHITTYSCRAPE_URL to Env**

In `/Users/nb/Desktop/Projects/github.com/CHITTYOS/chittycommand/src/index.ts`, add to Env type:

```typescript
  CHITTYSCRAPE_URL?: string;
```

**Step 2: Add to wrangler.toml**

```toml
CHITTYSCRAPE_URL = "https://scrape.chitty.cc"
```

**Step 3: Add scrapeClient to integrations.ts**

Append to `src/lib/integrations.ts`:

```typescript
// ── ChittyScrape ──────────────────────────────────────────────
// Browser automation for portals without APIs

export function scrapeClient(env: Env) {
  const baseUrl = env.CHITTYSCRAPE_URL;
  if (!baseUrl) return null;

  async function post<T>(path: string, body: unknown, token: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000), // Scrapes can take longer
      });
      if (!res.ok) {
        console.error(`[scrape] ${path} failed: ${res.status}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[scrape] ${path} error:`, err);
      return null;
    }
  }

  return {
    scrapeCourtDocket: (caseNumber: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/court-docket', { caseNumber }, token),

    scrapeCookCountyTax: (pin: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/cook-county-tax', { pin }, token),

    scrapeMrCooper: (property: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/mr-cooper', { property }, token),
  };
}
```

**Step 4: Verify compiles**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/lib/integrations.ts src/index.ts wrangler.toml
git commit -m "feat: add ChittyScrape client for browser automation integration"
```

---

### Task 12: Add scrape bridge routes to ChittyCommand

**Files:**
- Modify: `src/routes/bridge.ts` (add scrape section)

**Step 1: Add scrape bridge routes**

Add to `src/routes/bridge.ts` before the Cross-Service Status section. Update the import to include `scrapeClient`:

```typescript
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient, booksClient, assetsClient, scrapeClient } from '../lib/integrations';

// ── ChittyScrape ──────────────────────────────────────────────

/** Trigger court docket scrape and write results to cc_legal_deadlines */
bridgeRoutes.post('/scrape/court-docket', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const { caseNumber } = await c.req.json() as { caseNumber?: string };
  const targetCase = caseNumber || '2024D007847'; // Default: Arias v. Bianchi

  const result = await scrape.scrapeCourtDocket(targetCase, token);

  const sql = getDb(c.env);
  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('court_docket', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.data?.entries?.length || 0}, ${result?.error || null})`;

  if (result?.success && result.data) {
    // Update legal deadlines with new docket entries
    for (const entry of result.data.entries) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata)
        VALUES (${targetCase}, 'cook_county_circuit', 'docket_entry', ${entry.description?.slice(0, 500) || 'Docket entry'}, ${entry.description || null}, ${entry.date || new Date().toISOString()}, ${JSON.stringify({ filedBy: entry.filedBy, scraped: true })}::jsonb)
        ON CONFLICT DO NOTHING
      `;
    }

    // Update next hearing if available
    if (result.data.nextHearing) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, deadline_date, urgency_score, metadata)
        VALUES (${targetCase}, 'cook_county_circuit', 'hearing', ${'Next Hearing: ' + targetCase}, ${result.data.nextHearing}, 90, '{"scraped": true}'::jsonb)
        ON CONFLICT DO NOTHING
      `;
    }
  }

  return c.json({ source: 'court_docket', result });
});

/** Trigger Cook County tax scrape for all properties */
bridgeRoutes.post('/scrape/cook-county-tax', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const sql = getDb(c.env);

  // Get all properties with PINs
  const properties = await sql`SELECT id, address, unit, tax_pin, metadata FROM cc_properties WHERE tax_pin IS NOT NULL`;

  const results = [];
  for (const prop of properties) {
    const result = await scrape.scrapeCookCountyTax(prop.tax_pin as string, token);
    results.push({ pin: prop.tax_pin, result });

    if (result?.success && result.data) {
      // Update property with latest tax data
      await sql`
        UPDATE cc_properties SET
          annual_tax = ${result.data.totalTax},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ tax_year: result.data.taxYear, tax_installments: result.data.installments, last_tax_scrape: new Date().toISOString() })}::jsonb,
          updated_at = NOW()
        WHERE id = ${prop.id}
      `;

      // Push to ChittyFinance as liability update
      const finance = financeClient(c.env);
      if (finance) {
        // Fire-and-forget push to Finance
        try {
          await fetch(`${c.env.CHITTYFINANCE_URL}/api/accounts/liability`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
            body: JSON.stringify({
              externalId: `cookcounty-${prop.tax_pin}`,
              balance: String(result.data.totalTax),
              liabilityDetails: result.data,
            }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        } catch {}
      }
    }

    await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
      VALUES ('cook_county_tax', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;
  }

  return c.json({ properties_scraped: properties.length, results });
});

/** Trigger Mr. Cooper scrape */
bridgeRoutes.post('/scrape/mr-cooper', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const result = await scrape.scrapeMrCooper('addison', token);

  const sql = getDb(c.env);
  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('mr_cooper', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;

  if (result?.success && result.data) {
    // Update the Addison mortgage obligation
    await sql`
      UPDATE cc_obligations SET
        amount_due = ${result.data.monthlyPayment},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          mortgage_balance: result.data.currentBalance,
          escrow_balance: result.data.escrowBalance,
          interest_rate: result.data.interestRate,
          payoff_amount: result.data.payoffAmount,
          last_scrape: new Date().toISOString(),
        })}::jsonb,
        updated_at = NOW()
      WHERE payee ILIKE '%Mr. Cooper%541 W Addison%' OR payee ILIKE '%Mr. Cooper - 541%'
    `;

    // Push to ChittyFinance
    try {
      await fetch(`${c.env.CHITTYFINANCE_URL}/api/accounts/liability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify({
          externalId: 'mrcooper-addison-3s',
          balance: String(result.data.currentBalance),
          liabilityDetails: result.data,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {}
  }

  return c.json({ source: 'mr_cooper', result });
});
```

**Step 2: Add ChittyScrape to bridge status**

In the `/status` handler services array, add:

```typescript
    { name: 'chittyscrape', url: c.env.CHITTYSCRAPE_URL },
```

**Step 3: Verify compiles**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/routes/bridge.ts
git commit -m "feat: add scrape bridge routes (court-docket, cook-county-tax, mr-cooper)"
```

---

### Task 13: Wire scrape triggers into cron

**Files:**
- Modify: `src/lib/cron.ts` (implement court_docket, monthly_check stubs)

**Step 1: Add scrape functions to cron.ts**

In `src/lib/cron.ts`, import `scrapeClient` and implement the stubbed cron slots:

```typescript
import { plaidClient, financeClient, mercuryClient, scrapeClient } from './integrations';
```

Add these functions and wire them into `runCronSync`:

For `court_docket` (daily 7 AM CT):
```typescript
async function syncCourtDocket(env: Env, sql: any): Promise<number> {
  const scrape = scrapeClient(env);
  if (!scrape) return 0;

  const token = await env.COMMAND_KV.get('scrape:service_token');
  if (!token) return 0;

  const result = await scrape.scrapeCourtDocket('2024D007847', token);
  if (!result?.success) {
    console.error('[cron:court_docket] scrape failed:', result?.error);
    return 0;
  }

  let synced = 0;
  if (result.data?.entries) {
    for (const entry of result.data.entries) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata)
        VALUES ('2024D007847', 'cook_county_circuit', 'docket_entry', ${entry.description?.slice(0, 500) || 'Entry'}, ${entry.description || null}, ${entry.date || new Date().toISOString()}, '{"scraped":true}'::jsonb)
        ON CONFLICT DO NOTHING
      `;
      synced++;
    }
  }
  return synced;
}
```

For `monthly_check` (monthly 1st 9 AM CT):
```typescript
async function syncMonthlyChecks(env: Env, sql: any): Promise<number> {
  const scrape = scrapeClient(env);
  if (!scrape) return 0;

  const token = await env.COMMAND_KV.get('scrape:service_token');
  if (!token) return 0;

  let synced = 0;

  // Mr. Cooper mortgage
  try {
    const cooper = await scrape.scrapeMrCooper('addison', token);
    if (cooper?.success) synced++;
  } catch (err) {
    console.error('[cron:monthly] mr_cooper failed:', err);
  }

  // Cook County tax for all PINs
  const pins = ['14-21-111-008-1006', '14-28-122-017-1180', '14-28-122-017-1091', '14-16-300-032-1238'];
  for (const pin of pins) {
    try {
      const tax = await scrape.scrapeCookCountyTax(pin, token);
      if (tax?.success) synced++;
    } catch (err) {
      console.error(`[cron:monthly] cook_county_tax ${pin} failed:`, err);
    }
  }

  return synced;
}
```

Wire into the `runCronSync` switch:
```typescript
// In the court_docket block:
recordsSynced += await syncCourtDocket(env, sql);

// In the monthly_check block:
recordsSynced += await syncMonthlyChecks(env, sql);
```

**Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/cron.ts
git commit -m "feat: wire court docket and monthly scrapes into cron pipeline"
```

---

### Task 14: Add missing properties and PINs to ChittyCommand

**Files:**
- Create: `migrations/0005_add_properties_pins.sql`

**Step 1: Create migration**

```sql
-- Add missing properties (Surf 211 and Clarendon)
INSERT INTO cc_properties (address, unit, property_type, tax_pin, metadata)
VALUES ('550 W Surf St', 'C-211', 'condo', '14-28-122-017-1180',
  '{"purchase_price": null, "condo_declaration": "26911238", "building": "Commodore/Greenbriar Landmark"}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO cc_properties (address, unit, property_type, tax_pin, metadata)
VALUES ('4343 N Clarendon Ave', '#1610', 'condo', '14-16-300-032-1238',
  '{"source": "deed"}'::jsonb)
ON CONFLICT DO NOTHING;

-- Update existing properties with PINs
UPDATE cc_properties SET tax_pin = '14-21-111-008-1006'
WHERE address = '541 W Addison St' AND unit = '#3S' AND tax_pin IS NULL;

UPDATE cc_properties SET tax_pin = '14-28-122-017-1091'
WHERE address LIKE '%Surf%' AND unit IN ('#504', 'C-504') AND tax_pin IS NULL;

-- Add Cook County tax obligations for new properties
INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('property_tax', 'Cook County Tax Collector - 550 W Surf C-211', '2026-06-01', 'annual', 'pending',
  '{"property": "550 W Surf St C-211", "pin": "14-28-122-017-1180", "installments": "June + September"}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('property_tax', 'Cook County Tax Collector - 4343 N Clarendon', '2026-06-01', 'annual', 'pending',
  '{"property": "4343 N Clarendon Ave #1610", "pin": "14-16-300-032-1238", "installments": "June + September"}'::jsonb)
ON CONFLICT DO NOTHING;
```

**Step 2: Run migration**

```bash
psql $DATABASE_URL < migrations/0005_add_properties_pins.sql
```

**Step 3: Commit**

```bash
git add migrations/0005_add_properties_pins.sql
git commit -m "feat: add missing properties (Surf 211, Clarendon) with PINs and tax obligations"
```

---

### Task 15: Deploy ChittyCommand and seed scrape token

**Step 1: Seed ChittyScrape service token in ChittyCommand KV**

```bash
# Get the token from 1Password (stored in Task 10)
token=$(op read "op://Private/Mercury API Keys/ChittyScrape/service_token")
npx wrangler kv key put --binding COMMAND_KV --remote "scrape:service_token" "${token}"
```

**Step 2: Deploy**

```bash
npx wrangler deploy
```

**Step 3: Test scrape triggers**

```bash
bridge_token=$(op read "op://Private/Mercury API Keys/ChittyCommand Bridge/service_token")
curl -s -X POST https://command.chitty.cc/api/bridge/scrape/court-docket \
  -H "Authorization: Bearer ${bridge_token}" \
  -H "Content-Type: application/json" \
  -d '{"caseNumber": "2024D007847"}'
```

**Step 4: Push to GitHub**

```bash
git push origin main
```

---

### Task 16: Commit bridge auth changes from earlier session

The bridge auth middleware changes (bridgeAuthMiddleware) from the current session need to be committed.

**Step 1: Check git status**

```bash
git status
git diff src/middleware/auth.ts src/index.ts
```

**Step 2: Commit the auth changes**

```bash
git add src/middleware/auth.ts src/index.ts
git commit -m "feat: add bridge-specific auth middleware with service token support"
```

This should be done FIRST before any other ChittyCommand tasks.
