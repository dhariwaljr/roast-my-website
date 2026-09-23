# Roast My Website

Paste a URL. The server fetches the page, pulls real signals out of the HTML, and has an LLM
write a brutal, evidence-based roast plus a score out of 10.

Model generation runs on **Claude Sonnet** (`claude-sonnet-4-6`, direct Anthropic API) as the
primary model — the roast prompt was calibrated against it, and at current pricing a roast
costs roughly $0.011, so $5 of credit covers ~440 roasts (plenty for demand-validation traffic).
If Claude itself fails (outage, rate limit, credit exhausted), the app degrades gracefully
through two cheaper fallbacks instead of going down:

1. **Claude Sonnet** (`claude-sonnet-4-6`) — primary, `ANTHROPIC_API_KEY` required.
2. **DeepSeek** (`deepseek-flash`, DeepSeek-V4.1-Flash) — secondary, paid but extremely cheap
   (~$0.0002–$0.002/roast), `DEEPSEEK_API_KEY` optional.
3. **OpenRouter** (`google/gemma-4-31b-it:free`) — tertiary, a true last-resort free backstop,
   `OPENROUTER_API_KEY` optional.

Only the first tier is required. Each fallback is purely a resilience nicety — losing one just
means losing that safety net, not losing the app.

(An earlier version of this ran entirely on OpenRouter's free tier as the primary path. That
was abandoned after testing showed it too unreliable for a public tool: Kimi's free tier was
discontinued mid-project, several free models 429 under shared load, and the Nvidia Nemotron
free models turned out to be reasoning models that burn their whole token budget on visible
chain-of-thought and never produce an actual answer. DeepSeek then briefly served as primary
before being moved to the fallback tier in favor of Claude, for roast-quality reasons.)

No login, no database, nothing saved. One page, one API route.

---

## Running it locally

**1. Install dependencies**

```bash
npm install
```

**2. Add your API key(s)**

Copy the example file and drop your real key(s) in:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here

# Fallback chain — optional, only used if Claude itself fails.
DEEPSEEK_API_KEY=sk-your-actual-deepseek-key-here
OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here
```

- Get an Anthropic key (**required**) at [console.anthropic.com](https://console.anthropic.com/settings/keys).
- Get a DeepSeek key (optional fallback) at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
- Get a free OpenRouter key (optional last-resort fallback) at [openrouter.ai/keys](https://openrouter.ai/keys) —
  no payment method required.

`.env.local` is gitignored, and every key is only ever read server-side inside
`app/api/roast/route.ts` — none of them are sent to the browser.

**3. Run it**

```bash
npm run dev
```

Open <http://localhost:3000>.

---

## Deploying to Vercel

Either route works. `ANTHROPIC_API_KEY` is required in Vercel or the deployed app returns a
clear error; `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` are optional (fallback only).
`.env.local` is not uploaded.

### Option A — GitHub import (recommended)

1. Push this folder to a GitHub repository.
2. Go to [vercel.com/new](https://vercel.com/new) and click **Import** next to that repo.
3. Vercel auto-detects Next.js — leave the build settings alone.
4. **Before clicking Deploy**, expand **Environment Variables** and add:
   - **Key:** `ANTHROPIC_API_KEY` — **Value:** your real key
   - *(optional)* **Key:** `DEEPSEEK_API_KEY` — **Value:** your real key
   - *(optional)* **Key:** `OPENROUTER_API_KEY` — **Value:** your real key
   - **Environments:** tick Production, Preview, and Development for each
5. Click **Deploy**.

### Option B — Vercel CLI

```bash
npm i -g vercel
vercel login
vercel          # first run links the project and creates a preview deployment
```

Add the key(s), then ship to production:

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_API_KEY preview
vercel env add ANTHROPIC_API_KEY development
vercel env add DEEPSEEK_API_KEY production     # optional fallback
vercel env add OPENROUTER_API_KEY production   # optional fallback
vercel --prod
```

Each `vercel env add` prompts you to paste the value.

### Where to set or change the key(s) in the Vercel dashboard

**Your Project → Settings → Environment Variables → Add New**

- Key: `ANTHROPIC_API_KEY` (required) — Value: your key — Production, Preview, Development
- Key: `DEEPSEEK_API_KEY` (optional fallback) — Value: your key — same environments
- Key: `OPENROUTER_API_KEY` (optional fallback) — Value: your key — same environments

Environment variables are only picked up at build/deploy time, so after adding or editing
a key go to **Deployments → ⋯ on the latest deployment → Redeploy**.

---

## How it works

`POST /api/roast` with `{ "url": "example.com" }`:

1. Normalizes the URL (adds `https://` if missing) and rejects local/private addresses.
2. Fetches the page server-side with a real browser User-Agent and a **10-second timeout**.
   Any failure — DNS, refused connection, timeout, non-2xx status, expired certificate,
   non-HTML content type — comes back as a specific message, not a generic one.
3. Extracts, with cheerio: `<title>`, meta description, up to 5 `<h1>`s, total `<img>` count
   and how many lack `alt`, `<script>` count, inline `style=""` count, whether a mobile
   viewport tag exists, Google Fonts / `@font-face` references, total HTML size in KB,
   which call-to-action phrases appear, and a ~1200-character sample of visible body copy.
4. Sends only those real signals to Claude Sonnet (direct Anthropic Messages API) with
   instructions to roast using nothing but that evidence, no invented stats, no offer to
   help, ending in `SCORE: X/10`. If Claude's response looks like a transient failure
   (network error, 429/503, or an error wrapped inside an otherwise-200 response), it falls
   through to DeepSeek, then to the OpenRouter free model, before giving up.
5. Returns `{ url, roast, score, signals }`. The score is parsed out of the `SCORE:` line.

**Rate limiting:** 10 requests per hour per IP, in-memory. It resets on redeploy and is not
shared between serverless instances, so treat it as a cost guardrail rather than a hard
security control. To make it strict across instances, swap `lib/ratelimit.ts` for a
Vercel KV / Upstash Redis counter.

## Project layout

```
app/
  api/roast/route.ts   fetch, extract, prompt, call Claude (+ DeepSeek + OpenRouter fallbacks), parse score
  page.tsx             the single page (client component)
  layout.tsx           fonts + metadata
  globals.css          dark theme
lib/
  extract.ts           URL normalization + HTML signal extraction
  ratelimit.ts         in-memory per-IP sliding window
```
