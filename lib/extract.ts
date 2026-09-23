import * as cheerio from "cheerio";

export type Signals = {
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  imgCount: number;
  imgsMissingAlt: number;
  scriptCount: number;
  inlineStyleCount: number;
  hasViewport: boolean;
  fontReferences: number;
  bodySample: string;
  htmlSizeKb: number;
  ctaFound: string[];
};

const CTA_PHRASES = [
  "book now",
  "buy now",
  "get started",
  "sign up",
  "contact us",
  "shop now",
  "schedule",
  "call now",
];

/**
 * Accepts what a person actually types ("example.com", "  Example.COM/ ") and
 * turns it into an absolute http(s) URL, or throws with a message meant for the user.
 */
export function normalizeUrl(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("You didn't give me a URL. Bold, but no.");

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`"${trimmed}" isn't a URL I can parse. Check the spelling.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs work here.");
  }
  if (!parsed.hostname.includes(".")) {
    throw new Error(`"${parsed.hostname}" isn't a real domain. Try something like example.com.`);
  }

  return parsed.toString();
}

export function extractSignals(html: string, finalUrl: string): Signals {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || null;

  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;

  const h1s = $("h1")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .slice(0, 5);

  const imgs = $("img");
  const imgCount = imgs.length;
  let imgsMissingAlt = 0;
  imgs.each((_, el) => {
    const alt = $(el).attr("alt");
    if (alt === undefined || alt === null) imgsMissingAlt += 1;
  });

  const scriptCount = $("script").length;
  const inlineStyleCount = $("[style]").length;
  const hasViewport = $('meta[name="viewport"]').length > 0;

  // Google Fonts links/imports plus any @font-face declarations in inline <style>.
  const googleFontLinks = $(
    'link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]',
  ).length;
  const inlineCss = $("style")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .join("\n");
  const fontFaceBlocks = (inlineCss.match(/@font-face/gi) ?? []).length;
  const cssFontImports = (inlineCss.match(/fonts\.googleapis\.com/gi) ?? []).length;
  const fontReferences = googleFontLinks + fontFaceBlocks + cssFontImports;

  // Visible body copy: drop the machinery, keep what a human would read.
  // Tags collapse to spaces so adjacent blocks don't fuse into "HeadingThis is the body".
  const $body = cheerio.load(html);
  $body("script, style, noscript, template, svg, iframe").remove();
  const spaced = ($body("body").html() ?? "").replace(/<[^>]+>/g, " ");
  const bodySample = cheerio
    .load(`<div>${spaced}</div>`)
    .root()
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);

  const htmlSizeKb = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 10) / 10;

  const haystack = `${bodySample} ${$("a, button").text()}`.toLowerCase();
  const ctaFound = CTA_PHRASES.filter((phrase) => haystack.includes(phrase));

  return {
    finalUrl,
    title,
    metaDescription,
    h1s,
    imgCount,
    imgsMissingAlt,
    scriptCount,
    inlineStyleCount,
    hasViewport,
    fontReferences,
    bodySample,
    htmlSizeKb,
    ctaFound,
  };
}

export function signalsToPromptBlock(s: Signals): string {
  const lines = [
    `URL fetched: ${s.finalUrl}`,
    `<title>: ${s.title ?? "(none — the page has no title tag at all)"}`,
    `Meta description: ${s.metaDescription ?? "(none)"}`,
    `<h1> headings (${s.h1s.length} found${s.h1s.length === 0 ? "" : ", up to 5 shown"}): ${
      s.h1s.length ? s.h1s.map((h) => `"${h}"`).join(" | ") : "(none)"
    }`,
    `Images: ${s.imgCount} total, ${s.imgsMissingAlt} missing an alt attribute`,
    `<script> tags: ${s.scriptCount}`,
    `Inline style="" attributes: ${s.inlineStyleCount}`,
    `Mobile viewport meta tag: ${s.hasViewport ? "present" : "ABSENT"}`,
    `Google Fonts / @font-face references: ${s.fontReferences}`,
    `Total HTML size: ${s.htmlSizeKb} KB`,
    `Call-to-action phrases detected: ${s.ctaFound.length ? s.ctaFound.join(", ") : "(none found)"}`,
    ``,
    `Visible body copy sample (first ~1200 chars):`,
    s.bodySample ? `"""${s.bodySample}"""` : `(the page renders essentially no readable text server-side)`,
  ];
  return lines.join("\n");
}
