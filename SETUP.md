# RomSync chatbot backend: setup guide

## 1. Add the files to your portfolio repo
Copy everything from this zip into the same folder as `index.html` (keep the folder structure):
`api/`, `lib/`, `data/`, `scripts/`, `chat-widget.js`, `chat-widget.css`, `vercel.json`, `package.json`, `.gitignore`, `.env.example`.

Then add two lines to `index.html`:
- inside `<head>`:  `<link rel="stylesheet" href="chat-widget.css">`
- just before `</body>`:  `<script src="chat-widget.js" defer></script>`

## 2. Get your keys
1. **Gemini**: https://aistudio.google.com/apikey -> create a key. In AI Studio, open the rate-limit page and note your daily request limit for each model. Set `GLOBAL_DAILY_LIMIT` BELOW that number. Check that the model names in `GEMINI_MODELS` appear in your AI Studio model list.
2. **Telegram** (main alert channel): message @BotFather, send /newbot, copy the token. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. Do this on your own device and never share the token.
3. **Resend** (optional email backup): https://resend.com -> create an API key. Without your own domain it can only email the address you signed up with, which is what you want.
4. **Upstash Redis** (required for real rate limiting): Vercel project -> Storage / Marketplace -> add Upstash Redis (free). It adds the env vars for you.
5. **Calendly**: your link is already `https://calendly.com/rommeldelatorre8/30min`.

## 3. Environment variables (Vercel -> Project -> Settings -> Environment Variables)
See `.env.example`. Required: `GEMINI_API_KEY`, `IP_HASH_SALT` (any long random text), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the Redis variables. Redeploy after changing any of them.
Preview deployments use a different web address: add it to `ALLOWED_ORIGINS` or test on your main domain.

## 4. Test before going live
- `npm run test:local` runs 23 checks with fake Gemini/Telegram (no keys needed).
- After deploying: open the site, ask "How much do you charge?", then try nonsense ("asdfgh"), an off-topic question ("tell me a joke"), a question the sheet doesn't cover, and the "Send my details" form. Confirm the Telegram message arrives.
- Temporarily set a wrong `GEMINI_API_KEY` to confirm the "limited mode" fallback and the Telegram alert.

## 5. Updating the knowledge base
Edit the Google Sheet -> File -> Download -> .xlsx -> then:
`npm install` (first time only) and `npm run build-kb -- path/to/file.xlsx`, read the warnings, commit `data/knowledge.js`, push.
Only rows with Status = Ready are used.

## How the bot behaves
| Situation | What happens | Uses Gemini quota? |
|---|---|---|
| Quick-reply buttons, "hi", "thanks" | Answered from the sheet | No |
| Gibberish, injection attempts, private questions, obvious off-topic | Friendly refusal + a strike | No |
| Normal business question | Gemini answers from the sheet only | Yes |
| Not in the sheet | Bot says so and offers "Send my details to Rommel" | Yes |
| Gemini fails / quota used up / key invalid | Retry, fallback model, then answers from FAQ keywords, then a polite fallback. You get a Telegram alert (max 1/hour) | Skipped for 60s |
| 5 strikes in an hour | 30 minute pause for that visitor | No |
| Handoff form | Saved to Redis, sent to Telegram and email | No |
Limits per visitor (editable): 6 per minute, 30 per hour, 80 per day, 30 per conversation. Unrelated messages use two slots of the per-minute limit.
