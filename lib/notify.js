// Handoff notifications: Telegram (primary), email via Resend (backup), and ops alerts.
import { cfg } from './config.js';
import { fetchTimeout, escHtml } from './util.js';
import { setOnce } from './limiter.js';

export async function sendTelegram(html) {
  if (!cfg.tgToken || !cfg.tgChat) return { ok: false, skipped: true };
  try {
    const r = await fetchTimeout(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tgChat, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    }, 6000);
    if (!r.ok) console.error('[telegram] HTTP', r.status);
    return { ok: r.ok };
  } catch (e) { console.error('[telegram]', e.name); return { ok: false }; }
}

export async function sendEmail({ subject, text, replyTo }) {
  if (!cfg.resendKey) return { ok: false, skipped: true };
  try {
    const r = await fetchTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'RomSync Bot <onboarding@resend.dev>', to: [cfg.notifyEmail],
        subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 150), text, ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    }, 8000);
    if (!r.ok) console.error('[email] HTTP', r.status);
    return { ok: r.ok };
  } catch (e) { console.error('[email]', e.name); return { ok: false }; }
}

export function leadMessage(l) {
  const when = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
  const convo = l.transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
  return [
    '\u{1F514} <b>New chatbot lead</b>',
    `<b>Name:</b> ${escHtml(l.name)}`,
    `<b>Email:</b> ${escHtml(l.email)}`,
    `<b>Wants a call:</b> ${l.wantsMeeting ? 'Yes (Calendly link sent to them)' : 'No'}`,
    `<b>Message:</b> ${escHtml(l.message)}`,
    convo ? `\n<b>Recent chat:</b>\n${escHtml(convo)}` : '',
    `\n<i>${when} PHT | ${escHtml(l.country || '??')} | session ${escHtml(l.sessionId.slice(0, 8))}</i>`,
  ].filter(Boolean).join('\n');
}
export const leadEmailText = (l) => leadMessage(l).replace(/<\/?[a-z]+>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Alerts YOU when the bot is degraded. Throttled to one alert per hour per kind. */
export async function notifyOps(kind, text) {
  if (!(await setOnce(`alert:${kind}`, 3600))) return;
  const t = await sendTelegram(`<b>Chatbot alert</b>\n${escHtml(text)}`);
  if (!t.ok) await sendEmail({ subject: 'Chatbot alert', text });
}
