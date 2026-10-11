// Asks an AI model for the answer. Tries Gemini first, then Groq (backup). One call per message.
// Each provider has its own daily cap and its own pause (circuit breaker), so one outage never blocks the other.
import { cfg } from './config.js';
import { fetchTimeout, sleep } from './util.js';
import { takeBudget, breakerOpen, tripBreaker } from './limiter.js';

function parseJson(text) {
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const m = String(text).match(/\{[\s\S]*\}/);
  return tryParse(text) || (m ? tryParse(m[0]) : null);
}
async function failure(r, model, name) {
  const detail = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
  console.error(`[${name}]`, model, r.status, detail);   // the real reason shows up in Vercel -> Logs
  return { ok: false, status: r.status, detail };
}

async function callGemini(model, system, user, ms) {
  try {
    const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json' }, // no temperature: Gemini 3 rejects it
      }),
    }, ms);
    if (!r.ok) return failure(r, model, 'gemini');
    const j = await r.json();
    const cand = j.candidates && j.candidates[0];
    if (j.promptFeedback?.blockReason || !cand || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason)) return { ok: true, blocked: true, model };
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
    const data = parseJson(text);
    return data ? { ok: true, data, model } : { ok: false, reason: 'bad_json' };
  } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' }; }
}

async function callGroq(model, system, user, ms) {
  try {
    const r = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.groqKey}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }, ms);
    if (!r.ok) return failure(r, model, 'groq');
    const j = await r.json();
    const data = parseJson((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    return data ? { ok: true, data, model } : { ok: false, reason: 'bad_json' };
  } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' }; }
}

// compact = true: send a shorter prompt (Groq's free tier allows only ~12,000 tokens per minute)
const PROVIDERS = [
  { name: 'gemini', enabled: () => Boolean(cfg.geminiKey), models: () => cfg.models, limit: () => cfg.globalDailyLimit, call: callGemini, compact: false },
  { name: 'groq', enabled: () => Boolean(cfg.groqKey), models: () => cfg.groqModels, limit: () => cfg.groqDailyLimit, call: callGroq, compact: true },
];

async function tryProvider(p, system, user, errors) {
  const deadline = Date.now() + cfg.providerBudgetMs;
  for (const model of p.models()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 1500) return { ok: false, reason: 'all_failed' };
      if (!(await takeBudget(p.name, p.limit()))) return { ok: false, reason: 'budget' };
      const r = await p.call(model, system, user, Math.min(cfg.geminiTimeoutMs, left));
      if (r.ok) return r;
      errors.push(`${p.name}/${model}:${r.status || r.reason}${r.detail ? ' ' + r.detail.slice(0, 100) : ''}`);
      if (r.status === 402) return { ok: false, reason: 'billing' };           // credits depleted: other models fail the same way
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(r.detail || ''))) return { ok: false, reason: 'auth' };
      if (r.status === 429) break;                                              // quota hit: next model
      if (!(r.status >= 500 || ['timeout', 'network', 'bad_json'].includes(r.reason))) break; // 400/404: next model
      await sleep(300 + Math.random() * 300);                                   // short pause, then retry once
    }
  }
  return { ok: false, reason: 'all_failed' };
}

/** full / compact: system prompts (compact is a function). Returns { ok, data } or { ok:false, reason, reasons, errors } */
export async function askLLM({ full, compact, user }) {
  const errors = []; const reasons = []; let tried = 0;
  for (const p of PROVIDERS) {
    if (!p.enabled()) continue;
    if (await breakerOpen(p.name)) { reasons.push(`${p.name}:paused`); continue; }
    tried++;
    const r = await tryProvider(p, p.compact ? compact() : full, user, errors);
    if (r.ok) return { ...r, provider: p.name };
    reasons.push(`${p.name}:${r.reason}`);
    if (r.reason === 'billing' || r.reason === 'auth') await tripBreaker(p.name, 900);   // needs YOU to fix it: pause 15 min
    else if (r.reason === 'all_failed') await tripBreaker(p.name, 60);
  }
  const none = !PROVIDERS.some((p) => p.enabled());
  return { ok: false, reason: none ? 'auth' : tried ? 'all_failed' : 'paused', reasons: none ? ['no API key set'] : reasons, errors };
}

/** Used by /api/health: one tiny request per configured model. */
export async function probeAll() {
  const out = [];
  for (const p of PROVIDERS) {
    if (!p.enabled()) { out.push({ provider: p.name, model: '-', status: 0, result: 'no key set' }); continue; }
    for (const model of p.models()) {
      const r = await p.call(model, 'Reply with this JSON only: {"ok":true}', 'ping', 9000);
      out.push({ provider: p.name, model, status: r.ok ? 200 : r.status || 0, result: r.ok ? 'works' : (r.detail || r.reason || 'failed') });
    }
  }
  return out;
}
