import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LibraryFilter } from "./components/LibraryFilter";
import { Shelf } from "./components/Shelf";
import { TypedTitle } from "./components/TypedTitle";
import { essays, type Essay } from "./data/essays";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useReadSet } from "./hooks/useReadSet";

/** Shelf order is always newest issue first (the data's own order). */
const ORDER = new Map(essays.map((e, i) => [e.id, i]));

export default function App() {
  // null = show the whole shelf
  const [visible, setVisible] = useState<Essay[] | null>(null);
  const [bestId, setBestId] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const readSet = useReadSet();
  const reduced = usePrefersReducedMotion();
  // Drift Pause/Play lives here so it survives the shelf unmounting on an
  // empty search (WCAG 2.2.2). Reduced motion starts (and forces) it paused.
  const [paused, setPaused] = useState(reduced);
  useEffect(() => {
    if (reduced) setPaused(true);
  }, [reduced]);
  const readCount = useMemo(() => essays.reduce((n, e) => n + (readSet.has(e.id) ? 1 : 0), 0), [readSet]);
  // the "{n} read" toggle: only the books the visitor has read stay on the shelf
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    if (readCount === 0) setReadOnly(false); // nothing read any more: everything comes back
  }, [readCount]);

  const onFilter = useCallback((list: Essay[] | null, best: string | null, pill: string | null) => {
    setVisible(list);
    setBestId(best);
    setTopic(pill);
  }, []);

  // Search ranks results; the shelf keeps issue order (so the issue markers
  // still make sense) and glides to the best match instead.
  const baseList = useMemo(() => (visible ? [...visible].sort((a, b) => ORDER.get(a.id)! - ORDER.get(b.id)!) : essays), [visible]);
  // (the read set only matters while the filter is on: marking a book read doesn't reshuffle the shelf)
  const readDep = readOnly ? readSet : null;
  const shelfList = useMemo(() => (readDep ? baseList.filter((e) => readDep.has(e.id)) : baseList), [baseList, readDep]);
  // announce what the read filter left on the shelf
  const [readNote, setReadNote] = useState("");
  const lastToggle = useRef(0);
  const toggleRead = (e: { timeStamp: number }) => {
    // a double-click is one press: the second press's own time (the input's, not when the
    // page got round to it) within 80 ms of the first
    const now = e.timeStamp || performance.now();
    if (now - lastToggle.current < 80) return;
    lastToggle.current = now;
    const on = !readOnly;
    const base = visible ?? essays;
    const n = on ? base.filter((e) => readSet.has(e.id)).length : base.length;
    const where = topic ? ` in ${topic}` : "";
    setReadNote(on ? `${n} ${n === 1 ? "book" : "books"} you've read${where}` : `Read filter off: ${n} ${n === 1 ? "book" : "books"}${where}`);
    setReadOnly(on);
  };
  return (
    // the page is flat black top to bottom: no wall, no light, no grain (the shelf's canvas shows it through)
    <div className="relative flex min-h-dvh flex-col overflow-clip bg-background text-foreground">

      {/* AevyTV social links, top-right: Instagram above YouTube */}
      <nav
        aria-label="AevyTV social links"
        className="animate-rise absolute right-4 top-4 z-10 flex flex-col gap-0 sm:right-8 sm:top-8"
        style={{ animationDelay: "500ms" }}
      >
        <a
          href="https://www.instagram.com/aevytvdaily/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="AevyTV on Instagram"
          title="AevyTV on Instagram"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
            <circle cx="12" cy="12" r="4.2" />
            <circle cx="17.4" cy="6.6" r="0.9" fill="currentColor" stroke="none" />
          </svg>
        </a>
        <a
          href="https://www.youtube.com/@aevytv"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="AevyTV on YouTube"
          title="AevyTV on YouTube"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
            <path d="m10 15 5-3-5-3z" fill="currentColor" stroke="none" />
          </svg>
        </a>
      </nav>

      <header className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-8 sm:pt-8">
        <TypedTitle />
        {/* the counter, with Surprise me at the right end of the same row (the shelf portals it in) */}
        <div className="animate-rise mt-2.5 flex items-center justify-between gap-4 sm:mt-2" style={{ animationDelay: "240ms" }}>
        <p className="font-sans text-[16px] uppercase tracking-[0.24em] text-muted-foreground">
          {essays.length} reads
          {readCount > 0 ? (
            <>
              {" "}
              ·{" "}
              <button
                type="button"
                data-testid="read-count"
                aria-pressed={readOnly}
                title="Show only the reads you've opened"
                onClick={toggleRead}
                // (the same box in both states: a change of margins here would shift the whole page below)
                className={`-mx-2 rounded-full px-2 py-0.5 font-sans uppercase tracking-[0.24em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  readOnly ? "bg-cream text-background" : "text-primary hover:bg-foreground/5"
                }`}
              >
                {readCount} read
              </button>
            </>
          ) : null}
        </p>
        <div id="surprise-slot" className="shrink-0" />
        </div>
        <p className="sr-only" aria-live="polite">
          {readNote}
        </p>
        <div className="animate-rise mt-4 sm:mt-5" style={{ animationDelay: "380ms" }}>
          <LibraryFilter essays={essays} onChange={onFilter} />
        </div>
      </header>

      <main className="flex flex-1 flex-col pb-2 pt-4">
        {/* the shelf stays mounted when nothing matches: the other books are off it, not gone */}
        <Shelf
          essays={shelfList}
          focusId={bestId}
          topic={topic}
          readOnly={readOnly}
          emptyHint={readOnly ? "Turn off the read filter or pick another topic" : "Try fewer words or another topic"}
          paused={paused}
          onPausedChange={setPaused}
        />
      </main>

      <footer className="px-4 pb-6 pt-6 text-center font-sans text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
        An interesting website by <span className="normal-case">AevyTV</span>
      </footer>
    </div>
  );
}
