import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';

export const litigationRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const synthesizeSchema = z.object({
  rawNotes: z.string().min(1).max(50000),
  property: z.string().max(500).optional(),
  caseNumber: z.string().max(100).optional(),
});

const draftSchema = z.object({
  synthesizedFacts: z.string().min(1).max(50000),
  focus: z.string().max(200),
  recipient: z.string().max(200),
});

const qcSchema = z.object({
  rawNotes: z.string().min(1).max(50000),
  draftEmail: z.string().min(1).max(10000),
});

async function callAIGateway(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
): Promise<string> {
  const gateway = env.AI.gateway('chittygateway');
  const gatewayUrl = await gateway.getUrl();

  const chatModel = await env.COMMAND_KV.get('chat:model').catch(() => null)
    || 'dynamic/chittycommand';

  const response = await fetch(
    new URL('compat/chat/completions', gatewayUrl).toString(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('[litigation] AI gateway error:', response.status, errText);
    throw new Error(`AI gateway error (${response.status})`);
  }

  const result = await response.json() as {
    choices?: { message?: { content?: string } }[];
  };

  return result.choices?.[0]?.message?.content || '';
}

// ── Step 1+2: Fact Synthesizer ─────────────────────────────

litigationRoutes.post('/synthesize', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = synthesizeSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { rawNotes, property, caseNumber } = parsed.data;

  const systemPrompt = `You are a strict Litigation Support AI operating under Evidentiary Discipline.
Analyze the provided raw materials. Extract all facts and categorize them under these headings:
- Property Facts
- Case Posture
- Sale / Listing Status
- Prior Communications
- Financial / Fee Issues
- Sanctions / Motions

Use bullet points. CRITICAL: Every single bullet MUST begin with one of these EXACT tags:
[GIVEN] — if explicitly stated in the source material
[DERIVED] — if a logical inference from the material
[UNKNOWN] — if context requires it but the information is missing

Do not fabricate any facts. Do not editorialize. Output clean markdown with ## headings and bullet lists.`;

  const userPrompt = `Raw notes:\n${rawNotes}${property ? `\nProperty: ${property}` : ''}${caseNumber ? `\nCase: ${caseNumber}` : ''}`;

  try {
    const result = await callAIGateway(c.env, systemPrompt, userPrompt);
    return c.json({ synthesis: result });
  } catch (err) {
    console.error('[litigation/synthesize]', err instanceof Error ? err.message : err);
    return c.json({ error: 'AI synthesis failed. Please try again.' }, 502);
  }
});

// ── Step 3: Auto-Drafter ───────────────────────────────────

litigationRoutes.post('/draft', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { synthesizedFacts, focus, recipient } = parsed.data;

  const systemPrompt = `You are an expert litigation assistant drafting an email from a client to their attorney.
Rules:
1. Recipient: ${recipient}.
2. Focus: ${focus}.
3. Maximum 250 words.
4. Tone: Concise, professional, cooperative. This is attorney-client privileged communication.
5. Base the email ONLY on the provided synthesized facts.
6. Do NOT include facts marked [UNKNOWN] in the email body.
7. Facts marked [DERIVED] must be hedged with language like "Based on...", "It appears...", "My understanding is...".
8. Include specific action items or questions for the attorney.
9. Output the email as plain text with Subject line, greeting, body, and sign-off.`;

  try {
    const result = await callAIGateway(c.env, systemPrompt, `Synthesized facts:\n${synthesizedFacts}`);
    return c.json({ draft: result });
  } catch (err) {
    console.error('[litigation/draft]', err instanceof Error ? err.message : err);
    return c.json({ error: 'AI drafting failed. Please try again.' }, 502);
  }
});

// ── Step 4: Risk Scanner ───────────────────────────────────

litigationRoutes.post('/qc', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = qcSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { rawNotes, draftEmail } = parsed.data;

  const systemPrompt = `You are a rigorous Quality Control AI for litigation communications.
Compare the Drafted Email against the Original Source Notes.
Find ANY violations in these categories:
- HALLUCINATION: Information in the draft that is NOT present in the source notes
- MISSING: Crucial context from the source left out of the draft
- OVER-DISCLOSURE: Draft reveals unnecessary sensitive or strategic information
- AMBIGUOUS: Requests or statements that are unclear or could be misinterpreted

Output a JSON array of objects with these fields:
{ "flagType": "HALLUCINATION|MISSING|OVER-DISCLOSURE|AMBIGUOUS", "location": "where in the draft", "issue": "description", "suggestedFix": "how to fix it" }

If there are no issues, output an empty array: []
Output ONLY valid JSON, no markdown fences or explanation.`;

  const userPrompt = `Original Source Notes:\n"${rawNotes}"\n\nDrafted Email:\n"${draftEmail}"`;

  try {
    const result = await callAIGateway(c.env, systemPrompt, userPrompt);
    // Parse the JSON response, handling potential markdown fences
    const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const flags = JSON.parse(cleaned);
    return c.json({ flags });
  } catch (err) {
    console.error('[litigation/qc]', err instanceof Error ? err.message : err);
    if (err instanceof SyntaxError) {
      return c.json({ flags: [], warning: 'QC analysis returned non-parseable results' });
    }
    return c.json({ error: 'AI QC scan failed. Please try again.' }, 502);
  }
});
