// GET /api/health?token=YOUR_HEALTH_TOKEN  -> shows which settings are present and tests each Gemini model once.
// Disabled (404) unless you set the HEALTH_TOKEN environment variable. Remove that variable when you are done.
import { cfg } from '../lib/config.js';
import { json, fetchTimeout } from '../lib/util.js';

export default async function handler(req, res) {
  const token = process.env.HEALTH_TOKEN;
  if (!token || (req.query && req.query.token) !== token) return json(res, 404, { error: 'Not found' });
  const out = {
    settings: { geminiKey: Boolean(cfg.geminiKey), telegram: Boolean(cfg.tgToken && cfg.tgChat), resend: Boolean(cfg.resendKey), redis: Boolean(cfg.redisUrl && cfg.redisToken), models: cfg.models },
    gemini: [],
  };
  for (const model of cfg.models) {
    try {
      const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 50 } }),
      }, 9000);
      out.gemini.push({ model, status: r.status, result: r.ok ? 'works' : (await r.text()).replace(/\s+/g, ' ').slice(0, 400) });
    } catch (e) { out.gemini.push({ model, status: 0, result: e.name === 'AbortError' ? 'timed out' : 'network error' }); }
  }
  json(res, 200, out);
}
