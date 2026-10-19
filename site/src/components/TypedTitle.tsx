import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

/** The heading that types itself in. Change the site's welcome line here. */
const FULL = "Welcome to Interesting Reads";
const CHAR_MS = 95;
/** The caret lingers this long after the last letter, then fades out and is removed. */
const CARET_HOLD_MS = 800;
const CARET_FADE_MS = 400;

export function TypedTitle() {
  const reduced = usePrefersReducedMotion();
  const [typed, setTyped] = useState(0);
  const [caret, setCaret] = useState<"on" | "fading" | "gone">("on");
  const count = reduced ? FULL.length : typed;
  const done = count >= FULL.length;

  useEffect(() => {
    if (reduced || typed >= FULL.length) return;
    const t = window.setTimeout(() => setTyped((n) => n + 1), CHAR_MS);
    return () => window.clearTimeout(t);
  }, [typed, reduced]);

  useEffect(() => {
    if (reduced || !done || caret === "gone") return;
    const t =
      caret === "on"
        ? window.setTimeout(() => setCaret("fading"), CARET_HOLD_MS)
        : window.setTimeout(() => setCaret("gone"), CARET_FADE_MS);
    return () => window.clearTimeout(t);
  }, [reduced, done, caret]);

  const head = FULL.slice(0, Math.max(0, count - 1));
  const last = count > 0 ? FULL[count - 1] : "";
  const showCaret = !reduced && caret !== "gone" && last !== "";

  return (
    <h1
      aria-label={FULL}
      className="font-display text-[clamp(2.6rem,7.4vw,5.6rem)] font-light italic leading-[0.98] tracking-[-0.015em] text-balance"
    >
      {/* The untyped rest is laid out but invisible, so lines never jump while
          typing; the caret hangs off the last typed letter (absolutely
          positioned, so it never adds a line-break opportunity). It shows only
          while typing, then fades out and is removed. */}
      <span aria-hidden="true">
        {head}
        <span className="relative">
          {last}
          {showCaret ? (
            <span
              data-testid="title-caret"
              className="absolute left-full top-[0.16em] ml-[0.05em] h-[0.74em] w-[2px] bg-primary"
              style={{ opacity: caret === "fading" ? 0 : 1, transition: `opacity ${CARET_FADE_MS}ms ease-out` }}
            />
          ) : null}
        </span>
        <span className="opacity-0">{FULL.slice(count)}</span>
      </span>
    </h1>
  );
}
