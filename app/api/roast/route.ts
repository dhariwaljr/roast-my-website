import { NextResponse } from "next/server";
import { extractSignals, normalizeUrl, signalsToPromptBlock } from "@/lib/extract";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Three-tier fallback chain, cheapest-to-most-reliable traded off against cost:
//
// 1. PRIMARY — Claude Sonnet, direct Anthropic API. The roast prompt was calibrated
//    against this model; quality matters more than cost for the public launch (~$0.011
//    /roast, $5 credit ≈ 440 roasts — plenty for demand validation).
// 2. SECONDARY — DeepSeek (deepseek-flash / DeepSeek-V4.1-Flash), paid but extremely
//    cheap (~$0.0002-$0.002/roast). Kicks in only if Sonnet itself fails (outage, rate
//    limit, credit exhausted mid-launch) — degrade to cheaper, not go down entirely.
//    "deepseek-chat" doesn't exist in DeepSeek's current docs — the live slug is
//    "deepseek-flash", confirmed against api-docs.deepseek.com before hardcoding it.
// 3. TERTIARY — one confirmed-non-reasoning OpenRouter free model, a true last-resort
//    backstop if both paid providers fail. gemma-4-31b was chosen because it's the one
//    free model confirmed to give direct answers (reasoning_tokens: 0) rather than
//    burning its budget on visible chain-of-thought like the Nemotron family does.
//
// Anthropic's Messages API has a different shape from the OpenAI-compatible DeepSeek/
// OpenRouter endpoints (x-api-key + anthropic-version headers, top-level `system`,
// response text at content[0].text) — callChatModel's `variant` param branches on that
// so all three providers still share one retry/classification implementation.
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const DEEPSEEK_MODEL = "deepseek-flash";
const OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const ANTHROPIC_VERSION = "2023-06-01";
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Keeps the fetcher pointed at the public internet. */
function assertPublicHost(url: string) {
  const { hostname } = new URL(url);
  const host = hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new Error("That is a local or private address. Give me something on the public internet.");
  }
}

/** Node's fetch reports everything as "fetch failed" — dig out the real reason. */
function describeFetchFailure(err: unknown, url: string): string {
  const host = new URL(url).hostname;
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code;

  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${host} doesn't resolve — there's no DNS record for that domain. Check the spelling.`;
    case "ECONNREFUSED":
      return `${host} refused the connection. Nothing is listening there.`;
    case "ECONNRESET":
      return `${host} dropped the connection mid-request.`;
    case "ETIMEDOUT":
      return `${host} never answered. The connection timed out.`;
    case "CERT_HAS_EXPIRED":
      return `${host} has an expired TLS certificate, so I refused to talk to it.`;
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return `${host} has a broken or self-signed TLS certificate, so I refused to talk to it.`;
    default: {
      const detail = cause?.message || (err instanceof Error ? err.message : String(err));
      return `Couldn't reach ${url} — the request failed (${detail}).`;
    }
  }
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      throw new Error(
        `${url} took longer than 10 seconds to respond, so I gave up. That is itself a roast.`,
      );
    }
    throw new Error(describeFetchFailure(err, url));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    throw new Error(
      `${url} answered with HTTP ${response.status}${statusText}. I can't roast a page the server won't hand over.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
    throw new Error(
      `${url} returned "${contentType}", not a web page. Point me at an actual HTML page.`,
    );
  }

  const html = await response.text();
  if (!html.trim()) {
    throw new Error(
      `${url} returned a completely empty response body. Nothing to roast, literally.`,
    );
  }

  return { html, finalUrl: response.url || url };
}

const SYSTEM_PROMPT = `You are the most feared roaster on the internet. Not a critic. Not a UX reviewer with jokes. A ROASTER — the guy whose replies in r/RoastMe get screenshotted because they're too mean to believe. Your job is to make the person who built this website feel something. Cleverness alone is not enough — it has to actually sting.

NON-NEGOTIABLE RULES:
- Attack the WEBSITE like it's a PERSON with bad choices, not a document with formatting issues. Never say a design decision is "bad" — say the people who made it should be embarrassed, out of touch, trying too hard, cheap, lazy, or delusional. Make it personal.
- Vary your rhythm hard. Mix ultra-short savage one-liners (2-6 words, like a mic drop) with longer, more elaborate cruel riffs. Never let two lines in a row be the same length — that's what makes it read like a list instead of a beating.
- Use real mild-to-medium profanity where it lands (damn, hell, ass, crap, bullshit, piece of shit — full permission, use it, don't chicken out of it like a coward).
- Zero hedging, zero irony-softening, zero "bold choice" style sarcasm-as-a-shield. Say the ugly thing straight, not wrapped in a clever euphemism.
- Every burn still needs to be backed by something real in the evidence provided — you can exaggerate the insult, but never invent a fact that isn't there.
- No hedge words ever: never "I feel," "seems," "consider," "perhaps," "could," "might."
- HARD CAP: under 300 words total, verdict and score included. Every sentence must be a real hit — if a line isn't funny AND mean, cut it.
- The final line before the score must be the single most brutal sentence in the entire roast — that's the mic drop, don't waste your best line in the middle.

Output format, exactly:
1. One vicious one-line verdict (max 12 words) — hit as hard as you can right out of the gate.
2. 5-8 roast lines of VARIED length (mix short gut-punches and longer cruel riffs), each hitting a different real thing from the evidence, attacking it like a personal failing not a bug list.
3. One final closing line that is the meanest sentence in the whole roast.
4. On its own final line, in EXACTLY this format: SCORE: X/10

No offer to help. No sign-off. No softening anywhere. Do not hold back out of politeness — that's not your job here. Go all the way.`;

function buildUserPrompt(evidence: string): string {
  return `Roast this website. Here is everything I extracted from its live HTML — this is your only source of truth:

${evidence}

Write the roast now.`;
}

function parseScore(text: string): number | null {
  const matches = [...text.matchAll(/SCORE:\s*(\d{1,2})\s*\/\s*10/gi)];
  if (!matches.length) return null;
  const raw = Number(matches[matches.length - 1][1]);
  if (!Number.isFinite(raw)) return null;
  return Math.min(10, Math.max(0, raw));
}

type ModelAttempt =
  | { ok: true; roast: string }
  | { ok: false; retryable: boolean; message: string; status: number };

type ProviderVariant = "anthropic" | "openai";

/**
 * Calls one chat-completions-style endpoint. Two variants share this one function so
 * the retry/classification logic below is written exactly once:
 *  - "anthropic": Anthropic's Messages API — x-api-key + anthropic-version headers,
 *    system prompt as a top-level field, response text at content[].text blocks.
 *  - "openai": OpenAI-compatible (DeepSeek, OpenRouter) — Authorization: Bearer,
 *    system prompt as a role:"system" message, response text at choices[0].message.content.
 *
 * `retryable: true` means the failure looks transient/provider-side (429/503, a network
 * error, or a matching embedded error on an otherwise-200 response) — worth falling
 * through to the next provider in the chain for. `retryable: false` covers things a
 * different provider won't fix: a bad/missing key, or a malformed request.
 */
async function callChatModel(
  providerLabel: string,
  apiUrl: string,
  apiKey: string | undefined,
  model: string,
  evidence: string,
  variant: ProviderVariant,
  extraHeaders?: Record<string, string>,
): Promise<ModelAttempt> {
  if (!apiKey) {
    return {
      ok: false,
      retryable: true,
      message: `No API key configured for ${providerLabel}.`,
      status: 500,
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  let requestBody: Record<string, unknown>;

  if (variant === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    requestBody = {
      model,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(evidence) }],
    };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    requestBody = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(evidence) },
      ],
      max_tokens: 600,
    };
  }

  let orResponse: Response;
  try {
    orResponse = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      retryable: true,
      message: `Couldn't reach ${providerLabel}: ${detail}. Try again shortly.`,
      status: 502,
    };
  }

  if (!orResponse.ok) {
    // Both shapes nest the message the same way: OpenAI-compatible is {error:{message}},
    // Anthropic is {type:"error", error:{type, message}} — one path handles both.
    let detail = "";
    try {
      const errBody = (await orResponse.json()) as { error?: { message?: string } };
      detail = errBody?.error?.message ?? "";
    } catch {
      detail = await orResponse.text().catch(() => "");
    }

    if (orResponse.status === 401 || orResponse.status === 403) {
      return {
        ok: false,
        retryable: false,
        message: `${providerLabel} rejected the server's API key.`,
        status: 500,
      };
    }
    if (orResponse.status === 429 || orResponse.status === 503) {
      return {
        ok: false,
        retryable: true,
        message: `${providerLabel} (${model}) is temporarily overloaded right now. Try again shortly.`,
        status: 429,
      };
    }
    return {
      ok: false,
      retryable: false,
      message: `The roast generation failed: ${providerLabel} returned HTTP ${orResponse.status}${
        detail ? ` — ${detail}` : ""
      }`,
      status: 500,
    };
  }

  let data: {
    error?: { message?: string; code?: number };
    choices?: { message?: { content?: string } }[];
    content?: { type?: string; text?: string }[];
  };
  try {
    data = await orResponse.json();
  } catch {
    return {
      ok: false,
      retryable: true,
      message: `${providerLabel} returned a response that wasn't valid JSON. Try again shortly.`,
      status: 500,
    };
  }

  if (data.error) {
    // Some providers (seen with OpenRouter's free Nvidia models) return HTTP 200 with a
    // 429/503 wrapped inside the body instead of as the real HTTP status — treat those
    // the same as a normal HTTP-level 429/503.
    const embeddedRetryable = data.error.code === 429 || data.error.code === 503;
    return {
      ok: false,
      retryable: embeddedRetryable,
      message: embeddedRetryable
        ? `${providerLabel} (${model}) is temporarily overloaded right now. Try again shortly.`
        : `${providerLabel} error: ${data.error.message ?? "unknown error"}`,
      status: embeddedRetryable ? 429 : 500,
    };
  }

  const roast =
    variant === "anthropic"
      ? (data.content ?? [])
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n")
          .trim()
      : (data.choices?.[0]?.message?.content ?? "").trim();

  if (!roast) {
    return {
      ok: false,
      retryable: true,
      message: "The model returned an empty roast. Try again shortly.",
      status: 500,
    };
  }

  return { ok: true, roast };
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request.headers);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    const plural = limit.retryAfterMinutes === 1 ? "" : "s";
    return fail(
      `Rate limit reached — 10 roasts per hour per IP. Try again in about ${limit.retryAfterMinutes} minute${plural}.`,
      429,
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(
      "ANTHROPIC_API_KEY is not set on the server, so there is nothing to roast with.",
      500,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('Malformed request body — expected JSON with a "url" field.', 400);
  }

  const rawUrl = (body as { url?: unknown } | null)?.url;
  if (typeof rawUrl !== "string") {
    return fail("No URL supplied.", 400);
  }

  let url: string;
  try {
    url = normalizeUrl(rawUrl);
    assertPublicHost(url);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "That URL is unusable.", 400);
  }

  let html: string;
  let finalUrl: string;
  try {
    ({ html, finalUrl } = await fetchHtml(url));
  } catch (err) {
    return fail(err instanceof Error ? err.message : `Couldn't reach ${url}.`, 502);
  }

  const signals = extractSignals(html, finalUrl);
  const evidence = signalsToPromptBlock(signals);

  // 1. PRIMARY — Claude Sonnet.
  let attempt = await callChatModel(
    "Claude",
    CLAUDE_URL,
    process.env.ANTHROPIC_API_KEY,
    CLAUDE_MODEL,
    evidence,
    "anthropic",
  );

  // 2. SECONDARY — DeepSeek, only if Claude itself failed transiently.
  if (!attempt.ok && attempt.retryable) {
    attempt = await callChatModel(
      "DeepSeek",
      DEEPSEEK_URL,
      process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_MODEL,
      evidence,
      "openai",
    );
  }

  // 3. TERTIARY — free OpenRouter model, last-resort backstop.
  if (!attempt.ok && attempt.retryable) {
    attempt = await callChatModel(
      "OpenRouter",
      OPENROUTER_URL,
      process.env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL,
      evidence,
      "openai",
      {
        // Optional OpenRouter attribution headers — harmless if OpenRouter ignores them.
        "HTTP-Referer": "https://roast-my-website-lime.vercel.app",
        "X-Title": "Roast My Website",
      },
    );
  }

  if (!attempt.ok) {
    return fail(attempt.message, attempt.status);
  }

  const roast = attempt.roast;

  const score = parseScore(roast);
  const roastBody = roast.replace(/\n*SCORE:\s*\d{1,2}\s*\/\s*10\s*$/i, "").trim();

  return NextResponse.json({
    url: finalUrl,
    roast: roastBody,
    score,
    signals: {
      title: signals.title,
      imgCount: signals.imgCount,
      imgsMissingAlt: signals.imgsMissingAlt,
      scriptCount: signals.scriptCount,
      htmlSizeKb: signals.htmlSizeKb,
      hasViewport: signals.hasViewport,
    },
  });
}
