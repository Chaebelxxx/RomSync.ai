// Input validation and cheap local filters. These run BEFORE Gemini, so junk never costs quota.
import { cfg } from './config.js';
import { clean } from './util.js';

const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,190}\.[^\s@<>,;]{2,}$/;

export function validateChat(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request.' };
  if (typeof body.message !== 'string') return { error: 'Please type a message.' };
  if (body.message.length > cfg.maxMessageChars) return { error: `Please keep messages under ${cfg.maxMessageChars} characters.` };
  const message = clean(body.message, cfg.maxMessageChars);
  if (!message) return { error: 'Please type a message.' };
  if (!SESSION.test(String(body.sessionId || ''))) return { error: 'Invalid session. Please refresh the page.' };
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8)
    .map((h) => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', text: clean(h && h.text, 400) }))
    .filter((h) => h.text);
  return { message, history, sessionId: body.sessionId };
}

export function validateHandoff(b) {
  if (!b || typeof b !== 'object') return { error: 'Invalid request.' };
  const name = clean(b.name, 80);
  const email = clean(b.email, 120).toLowerCase();
  const message = clean(b.message, 1000);
  if (!name) return { error: 'Please enter your name.' };
  if (!EMAIL.test(email)) return { error: 'Please enter a valid email address.' };
  if (message.length < 5) return { error: 'Please add a short message (at least 5 characters).' };
  if (!SESSION.test(String(b.sessionId || ''))) return { error: 'Invalid session. Please refresh the page.' };
  const transcript = (Array.isArray(b.transcript) ? b.transcript : []).slice(-10)
    .map((h) => ({ role: h && h.role === 'assistant' ? 'Bot' : 'Visitor', text: clean(h && h.text, 300) }))
    .filter((h) => h.text);
  return {
    name, email, message, transcript, sessionId: b.sessionId,
    wantsMeeting: b.wantsMeeting === true,
    honeypot: clean(b.website, 50) !== '',          // bots fill the hidden field, humans never see it
    tooFast: Number(b.elapsedMs) < 1500,            // form "filled" in under 1.5 seconds = bot
  };
}

const INJECTION = /(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your|these)\s+(instructions?|rules?|prompts?|guidelines?)|system\s*prompt|developer\s*(message|mode)|(reveal|show|print|repeat|leak)\s+(me\s+)?(your|the)\s+(prompt|instructions?|rules|knowledge\s*base)|jailbreak|\bDAN\b|you\s+are\s+now\s+(a|an|the|my|dan|in)\b|pretend\s+(to\s+be|you\s+are)|<\/?\s*(system|assistant|visitor_message)/i;
const PRIVATE = /(home|house|residential)\s*address|where\s+exactly\s+(does|do)\s+(he|rommel|you)\s+live|exact\s+(location|address|whereabouts)|\b(password|passcode|otp|api\s*key|secret\s*key|access\s*token)\b|\b(girlfriend|boyfriend|wife|husband|married|relationship\s+status|dating)\b|\bhow\s+old\b|\bbirth\s*(day|date)\b|\bbank\s+account\b|\bgcash\s+number\b|\b(religion|political\s+party|nude|sexy)\b/i;
const PHONE = /(phone|mobile|cell|contact|whatsapp|viber|telegram)\s*(number|no\b|#)|\b(call|calling|phone|ring)\s+(him|rommel)\b|\bvia\s+(call|calling|phone)\b|\b(his|rommel'?s|your)\s+(phone\s+)?number\b/i;
const OFFTOPIC = /\bact\s+(like|as)\b|general\s+(purpose\s+)?chat\s*bot|hello\s+world|how\s+(do|can|to)\s+i\s+(build|make|create|code|write|learn)\b[^?]*\b(html|css|javascript|python|java|php|react|code|program)|\b(tell me a joke|joke|poem|song lyrics|lyrics|recipe|horoscope|zodiac|weather|homework|essay|riddle|lottery|bitcoin|crypto price|stock price|football|basketball|nba|movie|netflix|love advice|meaning of life|capital of|who is the president|translate this)\b/i;
const MASH = /qwert|asdf|zxcv|hjkl|uiop|wasd|lorem ipsum/i;

function gibberish(msg) {
  const letters = (msg.match(/\p{L}/gu) || []).length;
  if (letters < 2) return true;                                      // "???", "...", emoji only, "a"
  if (/(.)\1{5,}/u.test(msg)) return true;                           // "aaaaaaa"
  if (MASH.test(msg)) return true;                                   // keyboard mashing
  if (msg.length >= 6 && letters / msg.length < 0.4) return true;    // mostly symbols or digits
  const words = msg.toLowerCase().match(/[a-z]+/g) || [];            // Latin-script words only
  const bad = words.filter((w) => w.length >= 6 && (/[^aeiouy]{6,}/.test(w) || (w.match(/[aeiouy]/g) || []).length / w.length < 0.15)).length;
  return words.length > 0 && bad / words.length >= 0.5;
}

/** Returns { kind, weight } if the message should be refused locally, else null. */
export function prefilter(msg) {
  if (INJECTION.test(msg)) return { kind: 'injection', weight: 3 };
  if (PHONE.test(msg)) return { kind: 'phone', weight: 0 };
  if (PRIVATE.test(msg)) return { kind: 'personal', weight: 1 };
  if (gibberish(msg)) return { kind: 'gibberish', weight: 1 };
  if (OFFTOPIC.test(msg)) return { kind: 'offTopic', weight: 1 };
  return null;
}
