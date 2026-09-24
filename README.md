# Roast My Website

**Paste a URL. Get destroyed.**

An AI with zero incentive to be nice tears your website apart — the copy, the design,
the missing alt text, the dead call-to-action, all of it — and hands you a score out
of 10. No login, no signup, no "here's how we can help" pitch at the end.

This isn't feedback. This is a roast.

**→ [Try it live](https://roast-my-website-lime.vercel.app)**

---

### Example output

> *"This isn't a website. It's a digital tombstone for ambition. Half a kilobyte. My
> grocery list has more going on than this. A single HTML file with one heading, one
> paragraph, and the audacity to call itself a domain — that's not a website, that's a
> cry for help formatted in Arial... No meta description — because why would you want
> Google to find something this embarrassing? The SEO strategy here is witness
> protection... You didn't build a website. You left a sticky note on the internet and
> called it a launch."*
>
> **SCORE: 0/10**

That's real, unedited output from the deployed app.

---

### How it works

1. You paste a URL.
2. The server fetches the page's real HTML — no rendering, just the raw markup a
   browser would receive.
3. It extracts concrete signals: page title, meta description, heading structure,
   image count vs. missing alt text, script bloat, inline styles, whether a mobile
   viewport tag exists, and whether there's an obvious call-to-action.
4. Those signals go to an LLM with a prompt tuned specifically to produce genuine
   roast-comedy tone — short punchy lines mixed with longer cruel riffs, zero hedge
   words, real evidence behind every burn, no invented claims.
5. You get the roast and a score. Nothing you paste is saved or logged.

### Why it's actually mean, not just "critical"

Most "AI website critique" tools produce polite, forgettable output — a bulleted list
of suggestions nobody reads twice. This one is deliberately tuned the opposite
direction: no suggestions, no softening, no consultant-speak. Every roast is backed by
a real, verifiable fact pulled from the page (a missing alt tag, an absent CTA, a blank
meta description) — the exaggeration is in the delivery, never in the facts.

---

### Tech stack

- **Next.js**, deployed on **Vercel**
- LLM calls run through a **three-provider fallback chain** — if the primary model's
  API has an outage or hits a rate limit, it automatically retries against a backup
  provider, so the tool stays up even during a provider incident
- Rate-limited per IP to keep this sustainable as a free public tool

### Running it locally

```bash
git clone https://github.com/dhariwaljr/roast-my-website.git
cd roast-my-website
npm install
cp .env.local.example .env.local
# add your API key(s) to .env.local — see that file for which providers are supported
npm run dev
```

Open `http://localhost:3000`.

### Deploying your own copy

This is a standard Next.js app — deploys cleanly to Vercel:

```bash
npx vercel
```

Add your API key(s) as environment variables in the Vercel project dashboard before
your first production deploy.

---

### License

MIT — do whatever you want with this, including roasting it yourself. It's earned it.
