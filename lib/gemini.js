// Calls the Gemini API with timeouts, one retry, model fallback and a daily budget.
import { cfg } from './config.js';
import { fetchTimeout, sleep } from './util.js';
import { takeGeminiBudget } from './limiter.js';

function parseJson(text) {
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  return tryParse(text) || (text.match(/\{[\s\S]*\}/) ? tryParse(text.match(/\{[\s\S]*\}/)[0]) : null);
}

async function callOnce(model, system, user) {
  try {
    const r = await fetchTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          // No temperature/top_p: Gemini 3 models reject them. Room is left for thinking tokens.
          generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json' },
        }),
      },
      cfg.geminiTimeoutMs,
    );
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const cand = j.candidates && j.candidates[0];
    if (j.promptFeedback?.blockReason || !cand || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason)) {
      return { ok: true, blocked: true, model };
    }
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
    const data = parseJson(text);
    return data ? { ok: true, data, model } : { ok: false, reason: 'bad_json' };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

export async function askGemini({ system, user }) {
  if (!cfg.geminiKey) return { ok: false, reason: 'auth', errors: ['no GEMINI_API_KEY'] };
  const started = Date.now();
  const errors = [];
  for (const model of cfg.models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > cfg.totalBudgetMs) return { ok: false, reason: 'all_failed', errors };
      if (!(await takeGeminiBudget())) return { ok: false, reason: 'budget', errors };
      const r = await callOnce(model, system, user);
      if (r.ok) return r;
      errors.push(`${model}:${r.status || r.reason}`);
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'auth', errors }; // bad key: stop
      if (r.status === 429) break;                                  // quota hit: go straight to the next model
      const retryable = r.status >= 500 || ['timeout', 'network', 'bad_json'].includes(r.reason);
      if (!retryable) break;                                        // 400/404: try the next model
      await sleep(400 + Math.random() * 400);                       // short pause, then retry once
    }
  }
  return { ok: false, reason: 'all_failed', errors };
}
