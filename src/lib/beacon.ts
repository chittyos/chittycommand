import type { Env } from '../index';

export async function sendBeacon(env: Env) {
  try {
    if (!env.CHITTYREGISTER_URL) return;
    const url = `${env.CHITTYREGISTER_URL.replace(/\/$/, '')}/v1/beacon`;
    const payload = {
      name: 'ChittyCommand',
      version: '0.1.0',
      environment: env.ENVIRONMENT || 'production',
      canonicalUri: 'chittycanon://core/services/chittycommand',
      timestamp: new Date().toISOString(),
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' };
    if (env.CHITTY_CONNECT_TOKEN) headers['Authorization'] = `Bearer ${env.CHITTY_CONNECT_TOKEN}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const ok = res.ok;
    const now = new Date().toISOString();
    await env.COMMAND_KV.put('register:last_beacon_at', now);
    await env.COMMAND_KV.put('register:last_beacon_status', ok ? 'ok' : `http_${res.status}`);

    // Also emit beacon to ChittyConnect if configured (topology tracking)
    if (env.CHITTYCONNECT_URL) {
      try {
        const cu = `${env.CHITTYCONNECT_URL.replace(/\/$/, '')}/v1/beacon`;
        const ch = { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' } as Record<string, string>;
        if (env.CHITTY_CONNECT_TOKEN) ch['Authorization'] = `Bearer ${env.CHITTY_CONNECT_TOKEN}`;
        const cres = await fetch(cu, { method: 'POST', headers: ch, body: JSON.stringify(payload) });
        await env.COMMAND_KV.put('connect:last_beacon_at', now);
        await env.COMMAND_KV.put('connect:last_beacon_status', cres.ok ? 'ok' : `http_${cres.status}`);
      } catch {
        await env.COMMAND_KV.put('connect:last_beacon_status', 'error');
      }
    }
  } catch (e) {
    // Best-effort; record failure without throwing
    await env.COMMAND_KV.put('register:last_beacon_status', 'error');
  }
}
