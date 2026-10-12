// Chat widget. Add to index.html:  <link rel="stylesheet" href="chat-widget.css">  and  <script src="chat-widget.js" defer></script>
(() => {
  'use strict';
  const cs = document.currentScript;
  const API = (cs && cs.dataset.api) || '/api';          // change with data-api="http://localhost:3000/api" when testing
  const EMAIL = 'rommeldelatorre8@gmail.com';
  const GREETING = "Hi! I'm RomSync's AI assistant. I can tell you about Rommel's services, pricing, and how to start a project. What can I help with?";
  const QUICK = ['Services', 'Pricing', 'Get a quote', 'See projects', 'Contact'];
  const MAX = 500;

  // One random id per browser tab; the server uses it for per-conversation limits.
  let sid = null;
  try { sid = sessionStorage.getItem('rs_sid'); } catch (e) { /* storage blocked */ }
  if (!sid) {
    sid = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '');
    if (sid.length < 8) sid += 'session00';
    try { sessionStorage.setItem('rs_sid', sid); } catch (e) { /* ignore */ }
  }

  const history = [];
  let busy = false; let lockTimer = null; let formOpen = false; let lastUser = '';
  let handoffDone = false; let ctaCooldown = 0;   // show the "send my details" button sparingly

  // Small helper to build elements. Text is always set with textContent, never innerHTML (prevents XSS).
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((c) => c && el.append(c));
    return el;
  };
  const timeoutSignal = (ms) => (window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  // Turns emails, https links and the LinkedIn path into safe clickable links.
  const LINK = /(https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|linkedin\.com\/in\/[\w-]+)/gi;
  function linkify(parent, text) {
    let i = 0;
    for (const m of text.matchAll(LINK)) {
      const raw = m[0].replace(/[.,;!?]+$/, '');
      parent.append(text.slice(i, m.index));
      const href = raw.includes('@') && !/^https?:/i.test(raw) ? 'mailto:' + raw : /^https?:/i.test(raw) ? raw : 'https://' + raw;
      parent.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: raw }));
      i = m.index + raw.length;
    }
    parent.append(text.slice(i));
  }

  const log = h('div', { class: 'rs-log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'rs-input', rows: '1', maxlength: String(MAX), placeholder: 'Type your question...', 'aria-label': 'Your message' });
  const sendBtn = h('button', { class: 'rs-send', type: 'button', text: 'Send', onclick: () => send(input.value) });
  const panel = h('section', { class: 'rs-panel', role: 'dialog', 'aria-label': 'Chat with RomSync Assistant', hidden: '' },
    h('header', { class: 'rs-head' },
      h('div', {}, h('strong', { text: 'RomSync Assistant' }), h('small', { text: 'AI assistant. Final quotes come from Rommel.' })),
      h('button', { class: 'rs-x', type: 'button', 'aria-label': 'Close chat', text: '\u00D7', onclick: () => toggle(false) })),
    log,
    h('footer', { class: 'rs-foot' }, input, sendBtn));
  const fab = h('button', { class: 'rs-fab', type: 'button', 'aria-expanded': 'false', text: 'Chat with me', onclick: () => toggle(true) });
  document.body.append(fab, panel);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });

  function toggle(open) {
    panel.hidden = !open; fab.hidden = open; fab.setAttribute('aria-expanded', String(open));
    if (open) { if (!log.children.length) start(); input.focus(); } else fab.focus();
  }
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function addMsg(role, text, extras = []) {
    const b = h('div', { class: `rs-msg rs-${role}` });
    linkify(b, text);
    log.append(b); extras.forEach((el) => log.append(el)); scroll();
  }
  function chips() {
    return h('div', { class: 'rs-chips' }, QUICK.map((q) => h('button', { type: 'button', text: q, onclick: () => send(q) })));
  }
  function start() { addMsg('bot', GREETING); log.append(chips()); }

  function setDisabled(on, placeholder) {
    input.disabled = on; sendBtn.disabled = on;
    input.placeholder = placeholder || 'Type your question...';
  }
  function lock(seconds) {
    const s = Math.min(Number(seconds) || 30, 3600);
    setDisabled(true, s > 120 ? 'Chat paused. Please try again later.' : `Please wait ${s}s...`);
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { lockTimer = null; setDisabled(false); }, s * 1000);
  }

  function actionEls(data, force) {
    const acts = data.actions || []; const els = [];
    if (ctaCooldown > 0) ctaCooldown--;
    if (acts.includes('handoff') && !handoffDone && (force || ctaCooldown <= 0)) {
      els.push(h('button', { class: 'rs-cta', type: 'button', text: 'Send my details to Rommel', onclick: openForm }));
      ctaCooldown = 3;
    }
    if (acts.includes('schedule') && data.calendly) els.push(h('a', { class: 'rs-cta rs-alt', href: data.calendly, target: '_blank', rel: 'noopener noreferrer', text: 'Book a free 30-min call' }));
    return els.length ? [h('div', { class: 'rs-actions' }, els)] : [];
  }

  async function send(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    if (text.length > MAX) return addMsg('bot', `Please keep messages under ${MAX} characters.`);
    log.querySelectorAll('.rs-chips').forEach((c) => c.remove());
    addMsg('user', text); lastUser = text; input.value = '';
    busy = true; setDisabled(true);
    const typing = h('div', { class: 'rs-msg rs-bot rs-typing', text: 'Typing...' });
    log.append(typing); scroll();
    try {
      const r = await fetch(`${API}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sid, history: history.slice(-8) }),
        signal: timeoutSignal(30000),
      });
      const data = await r.json().catch(() => ({}));
      typing.remove();
      const reply = data.reply || `Something went wrong. Please try again, or email ${EMAIL}.`;
      history.push({ role: 'user', text }, { role: 'assistant', text: reply });
      addMsg('bot', reply, actionEls(data, QUICK.includes(text)));
      if (r.status === 429) lock(data.retryAfter);
    } catch (e) {
      typing.remove();
      addMsg('bot', `I can't reach the server right now. Please email Rommel at ${EMAIL}.`);
    } finally {
      busy = false; if (!lockTimer) { setDisabled(false); input.focus(); }
    }
  }

  function openForm() {
    if (formOpen) return; formOpen = true;
    const opened = Date.now();
    const name = h('input', { type: 'text', placeholder: 'Your name', maxlength: '80', autocomplete: 'name', 'aria-label': 'Your name' });
    const email = h('input', { type: 'email', placeholder: 'Your email', maxlength: '120', autocomplete: 'email', 'aria-label': 'Your email' });
    const msg = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'What would you like help with?', 'aria-label': 'Your message' });
    msg.value = QUICK.includes(lastUser) ? '' : lastUser;
    const hp = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', class: 'rs-hp' });
    const call = h('input', { type: 'checkbox' });
    const status = h('div', { class: 'rs-status', role: 'status' });
    const submit = h('button', { class: 'rs-cta', type: 'submit', text: 'Send' });
    const form = h('form', { class: 'rs-form', novalidate: '' },
      name, email, msg, hp,
      h('label', { class: 'rs-check' }, call, 'I would also like a call'),
      h('div', { class: 'rs-note', text: "By sending, you agree that Rommel may contact you about your inquiry. Chat messages are processed by AI services (Google Gemini or Groq). Please don't share passwords or sensitive data." }),
      status,
      h('div', { class: 'rs-row' }, submit, h('button', { class: 'rs-cta rs-alt', type: 'button', text: 'Cancel', onclick: () => { form.remove(); formOpen = false; input.focus(); } })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !/^\S+@\S+\.\S+$/.test(email.value.trim()) || msg.value.trim().length < 5) { status.textContent = 'Please fill in your name, a valid email and a short message.'; return; }
      submit.disabled = true; status.textContent = 'Sending...';
      try {
        const r = await fetch(`${API}/handoff`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.value, email: email.value, message: msg.value, wantsMeeting: call.checked, sessionId: sid, transcript: history.slice(-8), website: hp.value, elapsedMs: Date.now() - opened }),
          signal: timeoutSignal(20000),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          form.remove(); formOpen = false; handoffDone = true; input.focus();
          history.push({ role: 'assistant', text: '(The visitor has already sent their details to Rommel through the form.)' });
          addMsg('bot', data.reply || 'Thanks! I have passed this to Rommel.', data.calendly ? actionEls({ actions: ['schedule'], calendly: data.calendly }) : []);
        } else { status.textContent = data.reply || `Could not send. Please email ${EMAIL}.`; submit.disabled = false; }
      } catch (err) { status.textContent = `Network problem. Please email ${EMAIL}.`; submit.disabled = false; }
    });
    log.append(form); scroll(); name.focus();
  }
})();
