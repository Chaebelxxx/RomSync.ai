// POST /api/handoff  { name, email, message, wantsMeeting, sessionId, transcript, website, elapsedMs }
import { apiGate, json, clientIp, hashId } from '../lib/util.js';
import { validateHandoff } from '../lib/guard.js';
import { checkHandoffLimits, pushLead } from '../lib/limiter.js';
import { sendTelegram, sendEmail, leadMessage, leadEmailText } from '../lib/notify.js';
import { replies, calendlyLink } from '../lib/kb.js';
import { cfg } from '../lib/config.js';

export default async function handler(req, res) {
  try {
    if (apiGate(req, res)) return;
    const v = validateHandoff(req.body);
    if (v.error) return json(res, 400, { ok: false, reply: v.error });
    if (v.honeypot || v.tooFast) return json(res, 200, { ok: true, reply: replies.handoffOk() }); // bots get a fake "thanks"

    const lim = await checkHandoffLimits(hashId(clientIp(req)), hashId(v.email));
    if (!lim.ok) {
      const reply = lim.reason === 'duplicate' ? 'Thanks, I already passed your details to Rommel.' : `Too many requests right now. Please email Rommel at ${cfg.notifyEmail}.`;
      return json(res, 429, { ok: false, reply });
    }

    const lead = { ...v, country: req.headers['x-vercel-ip-country'] || '', at: new Date().toISOString() };
    await pushLead(lead).catch(() => {});                         // backup copy, so a lead is never lost
    const results = await Promise.allSettled([
      sendTelegram(leadMessage(lead)),
      sendEmail({ subject: `New chatbot lead: ${v.name}`, text: leadEmailText(lead), replyTo: v.email }),
    ]);
    const delivered = results.some((r) => r.status === 'fulfilled' && r.value && r.value.ok);
    if (!delivered) return json(res, 502, { ok: false, reply: replies.handoffFail() });

    return json(res, 200, {
      ok: true, reply: replies.handoffOk(),
      calendly: v.wantsMeeting ? calendlyLink({ name: v.name, email: v.email, note: v.message }) : undefined,
    });
  } catch (e) {
    console.error('[handoff]', e && e.message);
    return json(res, 500, { ok: false, reply: replies.handoffFail() });
  }
}
