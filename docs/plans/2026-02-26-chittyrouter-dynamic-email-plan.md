# ChittyRouter Dynamic Email Connections — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ChittyRouter's hardcoded email pipeline KV-backed so ChittyCommand can dynamically register Gmail accounts, user namespaces, and trigger syncs.

**Architecture:** Replace 3 hardcoded configs (Gmail accounts, email routing, token manager accounts) with KV reads from existing `AI_CACHE` namespace. Add 4 new HTTP endpoints to `unified-worker.js` for OAuth, namespace sync, email sync, and per-user filtering.

**Tech Stack:** Cloudflare Workers (JavaScript), KV storage, Gmail API, Google OAuth2, ChittyConnect

**Design doc:** `docs/plans/2026-02-26-chittyrouter-dynamic-email-design.md` (in chittycommand repo)

**Target repo:** `/Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyrouter/`

---

### Task 1: GmailTokenManager — Dynamic Account Config

**Files:**
- Modify: `src/email/gmail-token-manager.js`

**Step 1: Replace hardcoded accounts with KV + fallback**

Replace the constructor's hardcoded `this.accounts` (lines 14-30) and add KV-backed account lookup. The hardcoded accounts become a fallback for backward compatibility.

Replace lines 7-31 of `gmail-token-manager.js` with:

```javascript
export class GmailTokenManager {
  constructor(env) {
    this.env = env;
    this.tokenCache = new Map();
    this.refreshBuffer = 5 * 60 * 1000; // 5 minutes before expiry

    // Legacy hardcoded accounts — fallback if KV is empty
    this.legacyAccounts = {
      nick_aribia_main: {
        email: 'nick@aribia.cc',
        clientId: '187458330646-irp331653sb9c4f8mjgumsg75qbb59rm.apps.googleusercontent.com',
        opPath: 'op://Private/gmail-nick-aribia/credentials'
      },
      aribia_llc: {
        email: 'admin@aribia.cc',
        clientId: '187458330646-p0bho083tarmja05p89i0uc7d5lt96rr.apps.googleusercontent.com',
        opPath: 'op://Private/gmail-aribia-llc/credentials'
      },
      it_can_be_llc: {
        email: 'admin@itcanbe.llc',
        clientId: '187458330646-p0bho083tarmja05p89i0uc7d5lt96rr.apps.googleusercontent.com',
        opPath: 'op://Private/gmail-it-can-be/credentials'
      }
    };
  }
```

**Step 2: Add `getAccountConfig` method**

Add after the constructor (after line 31):

```javascript
  /**
   * Get account config — KV first, legacy fallback
   */
  async getAccountConfig(accountName) {
    // Try KV first
    try {
      const kvConfig = await this.env.AI_CACHE?.get(`gmail:account:${accountName}`, 'json');
      if (kvConfig) return kvConfig;
    } catch (e) {
      console.warn(`[token-manager] KV read failed for ${accountName}:`, e);
    }
    // Fallback to legacy
    return this.legacyAccounts[accountName] || null;
  }
```

**Step 3: Update `refreshToken` to use dynamic config**

Replace line 77 (`const account = this.accounts[accountName];`) with:

```javascript
    const account = await this.getAccountConfig(accountName);
```

For dynamic accounts with `connect_ref` instead of `opPath`, add a branch in `refreshToken` after the `getAccountConfig` call:

```javascript
    if (!account) {
      console.error(`Unknown account: ${accountName}`);
      return null;
    }

    try {
      let creds;
      if (account.connect_ref) {
        // Dynamic account — fetch credentials via ChittyConnect connect_ref
        creds = await this.getCredentialsFromConnectRef(account.connect_ref);
      } else if (account.opPath) {
        // Legacy account — fetch from 1Password
        creds = await this.getCredentialsFromOP(account.opPath);
      }
```

**Step 4: Add `getCredentialsFromConnectRef` method**

Add after `getCredentialsFromOP`:

```javascript
  /**
   * Get credentials from ChittyConnect by connect_ref
   */
  async getCredentialsFromConnectRef(connectRef) {
    try {
      const response = await fetch('https://connect.chitty.cc/credentials/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.env.CHITTYCONNECT_TOKEN}`
        },
        body: JSON.stringify({ ref: connectRef }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return await response.json();
      }

      console.warn(`[token-manager] ChittyConnect returned ${response.status} for ref ${connectRef}`);
      return null;
    } catch (error) {
      console.error('[token-manager] Failed to get credentials from ChittyConnect:', error);
      return null;
    }
  }
```

**Step 5: Update `getAccountNames` and `getAccountEmail`**

Replace lines 183-192:

```javascript
  /**
   * Get all configured account names — KV + legacy merged
   */
  async getAccountNames() {
    const names = new Set(Object.keys(this.legacyAccounts));
    try {
      const kvAccounts = await this.env.AI_CACHE?.get('gmail:accounts', 'json');
      if (Array.isArray(kvAccounts)) {
        for (const acct of kvAccounts) {
          if (acct.name) names.add(acct.name);
        }
      }
    } catch (e) {
      console.warn('[token-manager] Failed to read gmail:accounts from KV:', e);
    }
    return [...names];
  }

  /**
   * Get account email for display
   */
  async getAccountEmail(accountName) {
    const config = await this.getAccountConfig(accountName);
    return config?.email || accountName;
  }
```

**Step 6: Add `registerAccount` method**

Add before `testToken`:

```javascript
  /**
   * Register a new dynamic Gmail account in KV
   */
  async registerAccount(name, config) {
    // Save individual account config
    await this.env.AI_CACHE?.put(
      `gmail:account:${name}`,
      JSON.stringify(config)
    );

    // Update the accounts list
    const existing = await this.env.AI_CACHE?.get('gmail:accounts', 'json') || [];
    const filtered = existing.filter(a => a.name !== name);
    filtered.push({ name, email: config.email, user_id: config.user_id, connect_ref: config.connect_ref });
    await this.env.AI_CACHE?.put('gmail:accounts', JSON.stringify(filtered));

    console.log(`[token-manager] Registered account: ${name} (${config.email})`);
  }
```

**Step 7: Commit**

```bash
git add src/email/gmail-token-manager.js
git commit -m "feat: KV-backed Gmail account config with legacy fallback"
```

---

### Task 2: InboxMonitor — KV-backed Account List

**Files:**
- Modify: `src/email/inbox-monitor.js`

**Step 1: Make `getConfiguredInboxes` async + KV-backed**

Replace lines 71-79 of `inbox-monitor.js`:

```javascript
  /**
   * Get configured inbox sources — KV first, legacy fallback
   */
  async getConfiguredInboxes() {
    // Try KV for dynamic accounts
    try {
      const kvAccounts = await this.env.AI_CACHE?.get('gmail:accounts', 'json');
      if (Array.isArray(kvAccounts) && kvAccounts.length > 0) {
        const inboxes = kvAccounts.map(a => ({
          name: a.name,
          type: 'gmail',
          email: a.email,
          user_id: a.user_id || null,
        }));
        // Always include Cloudflare routing inbox
        inboxes.push({ name: 'chitty_router', type: 'cloudflare', domain: 'chitty.cc' });
        return inboxes;
      }
    } catch (e) {
      console.warn('[inbox-monitor] KV read failed, using legacy config:', e);
    }

    // Legacy fallback
    return [
      { name: 'nick_aribia_main', type: 'gmail', email: 'nick@aribia.cc' },
      { name: 'aribia_llc', type: 'gmail', email: 'admin@aribia.cc' },
      { name: 'it_can_be_llc', type: 'gmail', email: 'admin@itcanbe.llc' },
      { name: 'chitty_router', type: 'cloudflare', domain: 'chitty.cc' }
    ];
  }
```

Note: `getConfiguredInboxes` is already called with `await` on line 37, so making it async is safe.

**Step 2: Add `monitorSingleAccount` for on-demand sync**

Add after `monitorAllInboxes` (after line 66):

```javascript
  /**
   * Monitor a single account on-demand (triggered by ChittyCommand)
   */
  async monitorSingleAccount(connectRef, userId) {
    // Find the account by connect_ref in KV
    const accounts = await this.env.AI_CACHE?.get('gmail:accounts', 'json') || [];
    const account = accounts.find(a => a.connect_ref === connectRef);
    if (!account) {
      return { error: 'Account not found', connect_ref: connectRef };
    }

    const inbox = { name: account.name, type: 'gmail', email: account.email, user_id: userId };
    const emails = await this.fetchRecentEmails(inbox);
    const triaged = await this.triageEmails(emails, inbox);

    // Tag urgent items with user_id for per-user filtering
    for (const item of triaged.urgent) {
      item.user_id = userId;
    }

    // Update urgent items cache (append, don't replace)
    if (triaged.urgent.length > 0) {
      const urgentKey = 'email_urgent_items';
      const existing = await this.env.AI_CACHE?.get(urgentKey, 'json') || [];
      existing.unshift(...triaged.urgent);
      const trimmed = existing.slice(0, 100);
      await this.env.AI_CACHE?.put(urgentKey, JSON.stringify(trimmed), { expirationTtl: 86400 * 3 });
    }

    return {
      messages_fetched: emails.length,
      urgent_count: triaged.urgent.length,
      summary: triaged.summary,
    };
  }
```

**Step 3: Commit**

```bash
git add src/email/inbox-monitor.js
git commit -m "feat: KV-backed inbox list + single-account on-demand sync"
```

---

### Task 3: CloudflareEmailHandler — Namespace-based Routing

**Files:**
- Modify: `src/email/cloudflare-email-handler.js`

**Step 1: Rename `addressRoutes` to `systemRoutes` and add namespace lookup**

Replace lines 23-32:

```javascript
    // System address routing (not per-user — these are fixed)
    this.systemRoutes = {
      'intake@chitty.cc': { forward: 'nick@aribia.cc', priority: 'HIGH' },
      'legal@chitty.cc': { forward: 'nick@aribia.cc', priority: 'CRITICAL' },
      'evidence@chitty.cc': { forward: 'nick@aribia.cc', priority: 'HIGH' },
      'disputes@chitty.cc': { forward: 'nick@aribia.cc', priority: 'HIGH', category: 'dispute' },
      'calendar@chitty.cc': { forward: 'nick@aribia.cc', priority: 'MEDIUM' },
      'arias-v-bianchi@chitty.cc': { forward: 'nick@aribia.cc', priority: 'CRITICAL', case: 'ARIAS_v_BIANCHI' },
      'chittyos@chitty.cc': { forward: 'nick@aribia.cc', priority: 'MEDIUM' }
    };
```

**Step 2: Add `resolveRoute` method**

Add after the constructor:

```javascript
  /**
   * Resolve routing for an email address — namespace KV lookup, then system routes
   */
  async resolveRoute(toAddress) {
    // 1. Check system routes first (exact match)
    const systemRoute = this.systemRoutes[toAddress];
    if (systemRoute) {
      return { ...systemRoute, type: 'system' };
    }

    // 2. Check user namespace in KV
    const localPart = toAddress.split('@')[0];
    if (localPart) {
      try {
        const nsData = await this.env.AI_CACHE?.get(`email:namespace:${localPart}`, 'json');
        if (nsData?.user_id) {
          return {
            forward: 'nick@aribia.cc', // Default forward destination
            priority: 'MEDIUM',
            type: 'namespace',
            user_id: nsData.user_id,
            namespace: localPart,
          };
        }
      } catch (e) {
        console.warn(`[email-handler] Namespace lookup failed for ${localPart}:`, e);
      }
    }

    // 3. No match — return null (caller handles default)
    return null;
  }
```

**Step 3: Update `triageEmail` to use `resolveRoute` instead of `this.addressRoutes`**

Replace lines 141-152 in `triageEmail`:

```javascript
    // Check destination address priority (resolved dynamically)
    const addressRoute = await this.resolveRoute(emailData.to);
    if (addressRoute) {
      if (addressRoute.priority === 'CRITICAL') score += 30;
      else if (addressRoute.priority === 'HIGH') score += 20;
      else if (addressRoute.priority === 'MEDIUM') score += 10;

      if (addressRoute.case) {
        category = 'case';
        reasons.push(`case:${addressRoute.case}`);
      }
      if (addressRoute.user_id) {
        reasons.push(`user:${addressRoute.user_id}`);
      }
    }
```

**Step 4: Update `routeEmail` to use `resolveRoute`**

Replace lines 253-264:

```javascript
  async routeEmail(message, emailData, triage) {
    const route = await this.resolveRoute(emailData.to);

    if (route?.forward) {
      await message.forward(route.forward);
      console.log(`📤 Forwarded to ${route.forward} (${route.type || 'default'})`);
    } else {
      // Default forward
      await message.forward('nick@aribia.cc');
      console.log('📤 Forwarded to default (nick@aribia.cc)');
    }
  }
```

**Step 5: Tag logged emails with `user_id` when from namespace routing**

In `logEmail`, after `const logEntry = { ...emailData, ...triage };` (line 200-201), the user_id flows through from triage reasons. Also update the urgent items to include user attribution for per-user filtering:

In `handleEmail`, after `const triage = await this.triageEmail(emailData);` (line 46), add:

```javascript
      // Extract user_id from resolved route for per-user attribution
      const route = await this.resolveRoute(emailData.to);
      if (route?.user_id) {
        triage.user_id = route.user_id;
      }
```

**Step 6: Commit**

```bash
git add src/email/cloudflare-email-handler.js
git commit -m "feat: KV namespace-based email routing with system route fallback"
```

---

### Task 4: Unified Worker — New Endpoints

**Files:**
- Modify: `src/unified-worker.js`

**Step 1: Add route entries to the `this.routes` Map**

After line 94 (`["/email/urgent", this.handleUrgentEmails.bind(this)]`), add:

```javascript
      // Email Connection Management (called by ChittyCommand)
      ["/auth/gmail/connect", this.handleGmailConnect.bind(this)],
      ["/auth/gmail/callback", this.handleGmailCallback.bind(this)],
      ["/api/namespace-sync", this.handleNamespaceSync.bind(this)],
      ["/email/sync", this.handleEmailSync.bind(this)],
```

**Step 2: Add service auth helper**

Add after `matchPath` (after line 133):

```javascript
  /**
   * Validate service token for inter-service calls
   */
  isAuthorizedService(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    return token === this.env.CHITTYCONNECT_TOKEN;
  }
```

**Step 3: Add Gmail OAuth connect handler**

Add in the Email Monitoring Handlers section (after `handleUrgentEmails`):

```javascript
  // ============ Email Connection Handlers ============

  async handleGmailConnect(request) {
    if (request.method !== 'POST') {
      return this.jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (!this.isAuthorizedService(request)) {
      return this.jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { user_id, callback_url } = await request.json();
    if (!user_id || !callback_url) {
      return this.jsonResponse({ error: 'Missing user_id or callback_url' }, 400);
    }

    // Generate OAuth state for CSRF protection
    const state = btoa(JSON.stringify({ user_id, callback_url, ts: Date.now() }));

    // Store state in KV (10 min TTL)
    await this.env.AI_CACHE?.put(`oauth:state:${state}`, JSON.stringify({ user_id, callback_url }), {
      expirationTtl: 600
    });

    // Build Google OAuth URL
    const clientId = this.env.GOOGLE_CLIENT_ID || '187458330646-irp331653sb9c4f8mjgumsg75qbb59rm.apps.googleusercontent.com';
    const redirectUri = `https://router.chitty.cc/auth/gmail/callback`;
    const scope = 'https://www.googleapis.com/auth/gmail.readonly';

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&state=${encodeURIComponent(state)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    return this.jsonResponse({ auth_url: authUrl });
  }

  async handleGmailCallback(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return new Response(`OAuth error: ${error}`, { status: 400 });
    }
    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    // Validate state
    const stateData = await this.env.AI_CACHE?.get(`oauth:state:${state}`, 'json');
    if (!stateData) {
      return new Response('Invalid or expired state', { status: 400 });
    }
    await this.env.AI_CACHE?.delete(`oauth:state:${state}`);

    const { user_id, callback_url } = stateData;

    // Exchange code for tokens
    const clientId = this.env.GOOGLE_CLIENT_ID || '187458330646-irp331653sb9c4f8mjgumsg75qbb59rm.apps.googleusercontent.com';
    const clientSecret = this.env.GOOGLE_CLIENT_SECRET;

    if (!clientSecret) {
      return new Response('Server misconfiguration: missing GOOGLE_CLIENT_SECRET', { status: 500 });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://router.chitty.cc/auth/gmail/callback',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[gmail-oauth] Token exchange failed:', err);
      return new Response('Token exchange failed', { status: 500 });
    }

    const tokens = await tokenRes.json();

    // Get user email from Gmail profile
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = profileRes.ok ? await profileRes.json() : {};
    const emailAddress = profile.emailAddress || 'unknown';

    // Generate connect_ref and account name
    const connectRef = `gmail_${user_id}_${Date.now()}`;
    const accountName = `user_${user_id}_${emailAddress.replace(/[@.]/g, '_')}`;

    // Store tokens in KV (the token manager will use these)
    const expiry = new Date();
    expiry.setSeconds(expiry.getSeconds() + (tokens.expires_in || 3600));

    await this.env.AI_CACHE?.put(`gmail_token_${accountName}`, JSON.stringify({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expiry: expiry.toISOString(),
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    }), { expirationTtl: 3600 });

    // Store refresh token + client creds as the "connect_ref" credentials
    await this.env.AI_CACHE?.put(`credentials_${connectRef}`, JSON.stringify({
      refresh_token: tokens.refresh_token,
      client_secret: clientSecret,
      client_id: clientId,
    }));

    // Register account in token manager
    const { GmailTokenManager } = await import('./email/gmail-token-manager.js');
    const tokenManager = new GmailTokenManager(this.env);
    await tokenManager.registerAccount(accountName, {
      email: emailAddress,
      user_id,
      connect_ref: connectRef,
      clientId,
    });

    // Redirect back to ChittyCommand with connect_ref + email
    const redirectUrl = new URL(callback_url);
    redirectUrl.searchParams.set('connect_ref', connectRef);
    redirectUrl.searchParams.set('email_address', emailAddress);
    redirectUrl.searchParams.set('display_name', emailAddress);

    return Response.redirect(redirectUrl.toString(), 302);
  }
```

**Step 4: Add namespace sync handler**

```javascript
  async handleNamespaceSync(request) {
    if (request.method !== 'POST') {
      return this.jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (!this.isAuthorizedService(request)) {
      return this.jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { namespace, user_id } = await request.json();
    if (!namespace || !user_id) {
      return this.jsonResponse({ error: 'Missing namespace or user_id' }, 400);
    }

    await this.env.AI_CACHE?.put(
      `email:namespace:${namespace}`,
      JSON.stringify({ user_id, created_at: new Date().toISOString() })
    );

    console.log(`[namespace-sync] Mapped ${namespace}@chitty.cc → user ${user_id}`);
    return this.jsonResponse({ status: 'synced', namespace: `${namespace}@chitty.cc`, user_id });
  }
```

**Step 5: Add email sync handler**

```javascript
  async handleEmailSync(request) {
    if (request.method !== 'POST') {
      return this.jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (!this.isAuthorizedService(request)) {
      return this.jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { connect_ref, user_id } = await request.json();
    if (!connect_ref || !user_id) {
      return this.jsonResponse({ error: 'Missing connect_ref or user_id' }, 400);
    }

    const result = await this.services.email.inboxMonitor.monitorSingleAccount(connect_ref, user_id);
    return this.jsonResponse(result);
  }
```

**Step 6: Update `handleUrgentEmails` for per-user filtering**

Replace lines 542-554:

```javascript
  async handleUrgentEmails(request, url) {
    try {
      const userId = url?.searchParams?.get('user_id');
      const status = await this.env.AI_CACHE?.get('email_status', 'json');
      let urgent = status?.urgent_items || [];

      // Also check the direct urgent items cache
      const urgentItems = await this.env.AI_CACHE?.get('email_urgent_items', 'json') || [];
      if (urgentItems.length > urgent.length) {
        urgent = urgentItems;
      }

      let filtered = urgent.filter(i => i.urgencyScore >= 50);

      // Per-user filtering if user_id provided
      if (userId) {
        filtered = filtered.filter(i => i.user_id === userId);
      }

      return this.jsonResponse({
        count: filtered.length,
        items: filtered,
      });
    } catch (error) {
      return this.jsonResponse({ error: error.message }, 500);
    }
  }
```

**Step 7: Commit**

```bash
git add src/unified-worker.js
git commit -m "feat: add Gmail OAuth, namespace sync, email sync, per-user filtering endpoints"
```

---

### Task 5: Deploy and Verify

**Step 1: Deploy to Cloudflare**

```bash
cd /Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyrouter
npx wrangler deploy --env production
```

Note: `GOOGLE_CLIENT_SECRET` must be set as a wrangler secret:
```bash
wrangler secret put GOOGLE_CLIENT_SECRET --env production
```

**Step 2: Verify health**

```bash
curl -s https://router.chitty.cc/health | python3 -m json.tool
```

**Step 3: Verify namespace sync endpoint**

```bash
curl -s -X POST https://router.chitty.cc/api/namespace-sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"namespace":"test","user_id":"test-user"}' | python3 -m json.tool
```

**Step 4: Verify per-user urgent endpoint**

```bash
curl -s "https://router.chitty.cc/email/urgent?user_id=test-user" | python3 -m json.tool
```

**Step 5: Push**

```bash
git push origin main
```

---

## Summary

| Task | What | Files | Commit message |
|------|------|-------|----------------|
| 1 | Dynamic token manager | `gmail-token-manager.js` | `feat: KV-backed Gmail account config with legacy fallback` |
| 2 | Dynamic inbox monitor | `inbox-monitor.js` | `feat: KV-backed inbox list + single-account on-demand sync` |
| 3 | Namespace email routing | `cloudflare-email-handler.js` | `feat: KV namespace-based email routing with system route fallback` |
| 4 | New endpoints | `unified-worker.js` | `feat: add Gmail OAuth, namespace sync, email sync, per-user filtering endpoints` |
| 5 | Deploy + verify | — | push |
