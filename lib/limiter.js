// Rate limiting, abuse strikes, daily Gemini budget and circuit breaker.
// Uses Upstash Redis (REST) so limits are shared across all serverless instances.
// Without Redis it falls back to in-memory counters (fine for local tests, weak in production).
import { cfg } from './config.js';
import { fetchTimeout } from './util.js';

const mem = new Map(); // key -> { n, exp }
const useRedis = () => Boolean(cfg.redisUrl && cfg.redisToken);
const sweep = () => { if (mem.size > 5000) { const t = Date.now(); for (const [k, v] of mem) if (v.exp < t) mem.delete(k); } };

async function pipe(cmds) {
  const r = await fetchTimeout(`${cfg.redisUrl}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  }, 2500);
  if (!r.ok) throw new Error(`redis HTTP ${r.status}`);
  return (await r.json()).map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}
async function viaRedis(cmds) {
  if (!useRedis()) return null;
  try { return await pipe(cmds); } catch (e) { console.error('[redis]', e.message); return null; }
}

/** Add to counters. entries: [{ key, ttl, by }] -> array of new counts. */
export async function incrMany(entries) {
  const res = await viaRedis(entries.flatMap((e) => [['INCRBY', e.key, e.by ?? 1], ['EXPIRE', e.key, e.ttl, 'NX']]));
  if (res) return entries.map((_, i) => res[i * 2]);
  sweep();
  const t = Date.now();
  return entries.map((e) => {
    const by = e.by ?? 1; const m = mem.get(e.key);
    if (!m || m.exp < t) { mem.set(e.key, { n: by, exp: t + e.ttl * 1000 }); return by; }
    m.n += by; return m.n;
  });
}
export async function ttlOf(key) {
  const r = await viaRedis([['TTL', key]]);
  if (r) return r[0];
  const m = mem.get(key);
  return m && m.exp > Date.now() ? Math.ceil((m.exp - Date.now()) / 1000) : -2;
}
export async function setFlag(key, ttl) {
  if (!(await viaRedis([['SET', key, '1', 'EX', ttl]]))) mem.set(key, { n: 1, exp: Date.now() + ttl * 1000 });
}
/** True only the first time within ttl (used to throttle alerts). */
export async function setOnce(key, ttl) {
  const r = await viaRedis([['SET', key, '1', 'EX', ttl, 'NX']]);
  if (r) return r[0] === 'OK';
  const m = mem.get(key);
  if (m && m.exp > Date.now()) return false;
  mem.set(key, { n: 1, exp: Date.now() + ttl * 1000 });
  return true;
}
export async function pushLead(lead) {
  const s = JSON.stringify(lead);
  const r = await viaRedis([['LPUSH', 'leads', s], ['LTRIM', 'leads', 0, 199], ['EXPIRE', 'leads', 2592000]]);
  if (!r) console.log('[lead-backup]', s);
}

// Google resets the free quota at midnight Pacific time, so we count per Pacific day.
const dayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export async function checkChatLimits(ip, session) {
  const wait = await ttlOf(`blk:${ip}`);
  if (wait > 0) return { ok: false, reason: 'blocked', retryAfter: wait };
  const L = cfg.limits;
  const [min, hour, day, sess] = await incrMany([
    { key: `m:${ip}`, ttl: 60 }, { key: `h:${ip}`, ttl: 3600 }, { key: `d:${ip}`, ttl: 86400 }, { key: `s:${session}`, ttl: 86400 },
  ]);
  if (min > L.ipPerMin) return { ok: false, reason: 'burst', retryAfter: 60 };
  if (hour > L.ipPerHour) return { ok: false, reason: 'hourly', retryAfter: 3600 };
  if (day > L.ipPerDay) return { ok: false, reason: 'daily', retryAfter: 86400 };
  if (sess > L.sessionTotal) return { ok: false, reason: 'session', retryAfter: 3600 };
  return { ok: true };
}
/** Off-topic / nonsense / abusive messages add strikes. Enough strikes = temporary block. */
export async function strike(ip, weight = 1) {
  const [n] = await incrMany([{ key: `st:${ip}`, ttl: 3600, by: weight }]);
  if (n >= cfg.limits.strikesToBlock) { await setFlag(`blk:${ip}`, cfg.limits.blockSeconds); return { blocked: true, strikes: n }; }
  return { blocked: false, strikes: n };
}
/** Unrelated messages also use up an extra slot of the per-minute allowance. */
export const penalize = (ip) => incrMany([{ key: `m:${ip}`, ttl: 60 }]);

/** Daily call budget per provider. Google resets at midnight Pacific, Groq at midnight UTC. */
export async function takeBudget(name, limit) {
  const day = name === 'groq' ? new Date().toISOString().slice(0, 10) : dayKey();
  const [n] = await incrMany([{ key: `g:${name}:${day}`, ttl: 90000 }]);
  return n <= limit;
}
export const breakerOpen = async (name) => (await ttlOf(`cb:${name}`)) > 0;
export const tripBreaker = (name, sec = 60) => setFlag(`cb:${name}`, sec);

export async function checkHandoffLimits(ip, emailHash) {
  const L = cfg.limits;
  const [hr, day, same] = await incrMany([
    { key: `hh:${ip}`, ttl: 3600 }, { key: `hd:${ip}`, ttl: 86400 }, { key: `he:${emailHash}`, ttl: 600 },
  ]);
  if (hr > L.handoffPerHour || day > L.handoffPerDay) return { ok: false, reason: 'limit' };
  if (same > 1) return { ok: false, reason: 'duplicate' };
  return { ok: true };
}
