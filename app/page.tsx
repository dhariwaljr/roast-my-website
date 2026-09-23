"use client";

import { useEffect, useRef, useState } from "react";

type RoastResult = {
  url: string;
  roast: string;
  score: number | null;
};

const LOADING_STAGES = [
  "Fetching the page",
  "Reading it and losing respect for it",
];

function verdictFor(score: number | null): string {
  if (score === null) return "Unscoreable.";
  if (score <= 1) return "Genuinely offensive.";
  if (score <= 3) return "Embarrassing.";
  if (score <= 5) return "Forgettable.";
  if (score <= 6) return "Survivable.";
  if (score <= 7) return "Actually decent.";
  if (score <= 8) return "Annoyingly good.";
  return "Fine. You win.";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RoastResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Advance the status line from "fetching" to "reading" while the request is in flight.
  useEffect(() => {
    if (!loading) return;
    setStage(0);
    const timer = setTimeout(() => setStage(1), 2600);
    return () => clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (result && resultRef.current) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      resultRef.current.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
    }
  }, [result]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const response = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            `The server answered with HTTP ${response.status} and no explanation.`,
        );
        return;
      }

      setResult(data as RoastResult);
    } catch (err) {
      setError(
        err instanceof Error
          ? `The request never completed: ${err.message}`
          : "The request never completed.",
      );
    } finally {
      setLoading(false);
    }
  }

  // The roast is now short punchy lines rather than paragraphs — split on any
  // newline (single or blank) so each line renders as its own beat.
  const paragraphs = result
    ? result.roast
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  return (
    <main className="page">
      <h1 className="headline">
        <span>Roast My</span>
        <span className="accent">Website</span>
      </h1>

      <p className="tagline">
        Paste a URL. It gets fetched, read, and judged out of 10 on the evidence actually
        found in the HTML. No notes, no fixes, no mercy.
      </p>

      <form className="form" onSubmit={handleSubmit}>
        <label htmlFor="url" className="srOnly">
          Website URL
        </label>
        <input
          id="url"
          className="input"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          required
        />
        <button className="button" type="submit" disabled={loading || !url.trim()}>
          {loading ? "Roasting" : "Roast it"}
        </button>
      </form>

      <p className="status" role="status" aria-live="polite">
        {loading ? (
          <>
            {LOADING_STAGES[stage]}
            <span className="dots" aria-hidden="true" />
          </>
        ) : null}
      </p>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="result" ref={resultRef}>
          <div className="scoreBlock">
            <div className="scoreNumber">
              {result.score ?? "?"}
              <span className="outOf">/10</span>
            </div>
            <div>
              <div className="verdict">{verdictFor(result.score)}</div>
              <div className="subject">{result.url}</div>
            </div>
          </div>

          <div className="roast">
            {paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
}
