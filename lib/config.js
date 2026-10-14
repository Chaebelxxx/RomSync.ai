// All settings come from environment variables (set them in the Vercel dashboard).
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const list = (v, d) => String(v || d).split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  geminiKey: process.env.GEMINI_API_KEY || '',
  // Tried in order. If the first is rate limited or down, the next one is used.
  models: list(process.env.GEMINI_MODELS, 'gemini-3.5-flash-lite,gemini-3.6-flash'),
  geminiTimeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 7000),
  totalBudgetMs: 22000, // stop trying after this long (function limit is 30s)
  globalDailyLimit: int(process.env.GLOBAL_DAILY_LIMIT, 300), // max Gemini calls per day, keeps you under the free quota
  groqKey: process.env.GROQ_API_KEY || '',
  groqModels: list(process.env.GROQ_MODELS, 'llama-3.3-70b-versatile,llama-3.1-8b-instant'),
  groqDailyLimit: int(process.env.GROQ_DAILY_LIMIT, 400),  // max Groq calls per day
  providerBudgetMs: 10000, // max time spent on one provider before moving to the next

  allowedOrigins: list(process.env.ALLOWED_ORIGINS, 'https://romsyncai.vercel.app,http://localhost:3000'),
  calendlyUrl: process.env.CALENDLY_URL || 'https://calendly.com/rommeldelatorre8/30min',

  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  resendKey: process.env.RESEND_API_KEY || '',
  notifyEmail: process.env.NOTIFY_EMAIL || 'rommeldelatorre8@gmail.com',

  redisUrl: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, ''),
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
  salt: process.env.IP_HASH_SALT || 'dev-salt-change-me', // IPs are hashed with this before being stored

  maxMessageChars: 500,
  limits: {
    ipPerMin: int(process.env.LIMIT_IP_PER_MIN, 6),
    ipPerHour: int(process.env.LIMIT_IP_PER_HOUR, 30),
    ipPerDay: int(process.env.LIMIT_IP_PER_DAY, 80),
    sessionTotal: int(process.env.LIMIT_SESSION_TOTAL, 30),
    strikesToBlock: 5, // off-topic/abusive strikes within 1 hour before a temporary block
    blockSeconds: 1800,
    handoffPerHour: 3,
    handoffPerDay: 6,
  },
};
