import crypto from 'node:crypto';
import { cfg } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Normalise text: strip control/invisible characters, collapse whitespace, cap length.
export const clean = (s, max = 500) =>
  String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const stripAngles = (s) => String(s).replace(/[<>]/g, '');
export const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const hashId = (v) => crypto.createHash('sha256').update(cfg.salt + String(v)).digest('hex').slice(0, 24);
export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
export async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
export function json(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
// Shared front door for every API route. Returns true if it already answered (stop there).
export function apiGate(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (origin) {
    if (!cfg.allowedOrigins.includes(origin)) { json(res, 403, { reply: 'Forbidden.' }); return true; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); json(res, 405, { reply: 'Method not allowed.' }); return true; }
  if (!String(req.headers['content-type'] || '').includes('application/json')) { json(res, 415, { reply: 'Unsupported content type.' }); return true; }
  if (JSON.stringify(req.body ?? {}).length > 30000) { json(res, 413, { reply: 'Request too large.' }); return true; }
  return false;
}
