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

// Groq and OpenRouter both speak the OpenAI chat format, so one builder serves both.
function openAICompat(name, url, getKey, headers = {}, extra = () => ({})) {
  return async (model, system, user, ms) => {
    const post = (jsonMode) => fetchTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}`, ...headers },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 1000, // room for "reasoning" models to think and still answer
        ...extra(model),
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }, ms);
    try {
      let r = await post(true);
      if (r.status === 400 && /json|response_format/i.test(await r.clone().text().catch(() => ''))) r = await post(false); // model can't do JSON mode: retry plain
      if (!r.ok) return failure(r, model, name);
      const j = await r.json();
      if (j.error) { // OpenRouter sometimes reports errors inside a 200 response
        console.error(`[${name}]`, model, JSON.stringify(j.error).slice(0, 300));
        return { ok: false, status: Number(j.error.code) || 502, detail: String(j.error.message || '').slice(0, 300) };
      }
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const data = parseJson((msg && msg.content) || '');
      return data ? { ok: true, data, model } : { ok: false, reason: 'bad_json' };
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' }; }
  };
}
const callGroq = openAICompat('groq', 'https://api.groq.com/openai/v1/chat/completions', () => cfg.groqKey, {},
  (m) => (/gpt-oss/.test(m) ? { reasoning_effort: 'low' } : {}));
const callOpenRouter = openAICompat('openrouter', 'https://openrouter.ai/api/v1/chat/completions', () => cfg.openrouterKey,
  { 'HTTP-Referer': 'https://romsyncai.vercel.app', 'X-Title': 'RomSync chatbot' },
  () => (cfg.openrouterDenyLogging ? { provider: { data_collection: 'deny' } } : {})); // only providers that don't log or train on prompts

// compact = true: send a shorter prompt (Groq's free tier allows only ~12,000 tokens per minute)
const PROVIDERS = [
  //{ name: 'gemini', enabled: () => Boolean(cfg.geminiKey), models: () => cfg.models, limit: () => cfg.globalDailyLimit, call: callGemini, compact: false, budgetMs: 11000 },
  { name: 'groq', enabled: () => Boolean(cfg.groqKey), models: () => cfg.groqModels, limit: () => cfg.groqDailyLimit, call: callGroq, compact: true, budgetMs: 7000 },
  { name: 'openrouter', enabled: () => Boolean(cfg.openrouterKey), models: () => cfg.openrouterModels, limit: () => cfg.openrouterDailyLimit, call: callOpenRouter, compact: true, budgetMs: 7000 },
];

async function tryProvider(p, system, user, errors) {
  const deadline = Date.now() + p.budgetMs;
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
      if (r.status === 429 || r.reason === 'timeout') break;                    // quota hit or too slow: go to the next model
      if (!(r.status >= 500 || ['network', 'bad_json'].includes(r.reason))) break;   // 400/404: next model
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

/** Used by /api/health: which model IDs each key can actually call. */
export async function listAvailable() {
  const out = {};
  if (cfg.geminiKey) {
    try {
      const r = await fetchTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': cfg.geminiKey } }, 8000);
      const j = await r.json().catch(() => ({}));
      out.gemini = r.ok ? (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name)).map((m) => m.name.replace('models/', '')) : `HTTP ${r.status}`;
    } catch { out.gemini = 'could not load'; }
  }
  if (cfg.groqKey) {
    try {
      const r = await fetchTimeout('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${cfg.groqKey}` } }, 8000);
      const j = await r.json().catch(() => ({}));
      out.groq = r.ok ? (j.data || []).map((m) => m.id).filter((id) => !/whisper|tts|guard|orpheus|embed/i.test(id)) : `HTTP ${r.status}`;
    } catch { out.groq = 'could not load'; }
  }
  if (cfg.openrouterKey) {
    try {
      const r = await fetchTimeout('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${cfg.openrouterKey}` } }, 8000);
      const j = await r.json().catch(() => ({}));
      out.openrouter_free = r.ok ? (j.data || []).filter((m) => Number(m.pricing && m.pricing.prompt) === 0 && Number(m.pricing && m.pricing.completion) === 0 && !/image|audio|embed/i.test(m.id)).map((m) => m.id).slice(0, 40) : `HTTP ${r.status}`;
    } catch { out.openrouter_free = 'could not load'; }
  }
  return out;
}
