import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { CurlyArrow } from "./Doodles";

/** The heading that writes itself in. Change the site's headline here. */
const FULL = "Interesting Reads by AevyTV";
/** It sets on two lines: the first ends here (before " by"). */
const BREAK = FULL.indexOf(" by ");
const CHAR_MS = 95;

export function TypedTitle() {
  const reduced = usePrefersReducedMotion();
  const [typed, setTyped] = useState(0);
  const count = reduced ? FULL.length : typed;
  const done = count >= FULL.length;

  useEffect(() => {
    if (reduced || typed >= FULL.length) return;
    const t = window.setTimeout(() => setTyped((n) => n + 1), CHAR_MS);
    return () => window.clearTimeout(t);
  }, [typed, reduced]);

  // each line: the typed part, then the untyped rest laid out but invisible (so nothing
  // jumps while it types; no caret)
  const line = (from: number, to: number) => (
    <>
      {FULL.slice(from, Math.max(from, Math.min(count, to)))}
      <span className="opacity-0">{FULL.slice(Math.max(from, Math.min(count, to)), to)}</span>
    </>
  );

  return (
    <h1 aria-label={FULL} // (phones: sized so the first line always clears the social icons at the top right; the
      // bottom padding keeps the descenders of "by AevyTV" inside the box, so what follows clears them)
      className="font-display text-[min(2.9rem,calc((100vw-5.5rem)/6.4))] font-bold leading-[0.92] tracking-[0.005em] text-foreground pb-[0.16em] sm:text-[clamp(2.9rem,8vw,5.4rem)]">
      <span aria-hidden="true">
        <span className="relative inline-block">
          {line(0, BREAK)}
          {/* the curly doodle beside "Reads", pointing down toward the search and the shelf (phones: no room for it) */}
          <CurlyArrow
            className={`absolute left-full top-[0.08em] ml-[0.28em] hidden h-[0.62em] w-[0.47em] text-doodle/80 transition-opacity duration-700 sm:block ${done ? "opacity-100" : "opacity-0"}`}
          />
        </span>
        <br />
        {line(BREAK + 1, FULL.length)}
      </span>
    </h1>
  );
}
