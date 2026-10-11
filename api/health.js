// GET /api/health?token=YOUR_HEALTH_TOKEN  -> shows which settings are present and tests each AI model once.
// Disabled (404) unless you set the HEALTH_TOKEN environment variable. Remove that variable when you are done.
import { cfg } from '../lib/config.js';
import { json } from '../lib/util.js';
import { probeAll } from '../lib/llm.js';

export default async function handler(req, res) {
  const token = process.env.HEALTH_TOKEN;
  if (!token || (req.query && req.query.token) !== token) return json(res, 404, { error: 'Not found' });
  json(res, 200, {
    settings: { gemini: Boolean(cfg.geminiKey), groq: Boolean(cfg.groqKey), telegram: Boolean(cfg.tgToken && cfg.tgChat), resend: Boolean(cfg.resendKey), redis: Boolean(cfg.redisUrl && cfg.redisToken) },
    models: await probeAll(),
  });
}
