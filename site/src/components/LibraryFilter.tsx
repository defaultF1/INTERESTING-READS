import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Essay } from "../data/essays";
import { searchEssays } from "../lib/search";

type Props = {
  essays: Essay[];
  /**
   * The visible list in search-rank order (or null to show everything) and
   * the best search match, if a search is active, and the topic pill in use.
   */
  onChange: (visible: Essay[] | null, bestId: string | null, topic: string | null) => void;
};

const DEBOUNCE_MS = 600;
const MIN_CHARS = 2;

type SearchResult = { q: string; ids: string[] } | { q: string; error: string };

export function LibraryFilter({ essays, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const reqId = useRef(0);
  const pillRow = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const active = q.length >= MIN_CHARS;

  // Pills are built from the topics present, most common first.
  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of essays) for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [essays]);

  // Debounced, race-guarded search.
  useEffect(() => {
    const id = ++reqId.current;
    if (!active) return;
    const timer = window.setTimeout(() => {
      searchEssays(q)
        .then((ids) => {
          if (id === reqId.current) setResult({ q, ids });
        })
        .catch(() => {
          if (id === reqId.current) setResult({ q, error: "Search is unavailable right now." });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q, active]);

  const pending = active && result?.q !== q;
  const failed = active && !pending && result !== null && "error" in result ? result.error : null;
  // Keep showing the previous results while the next search is pending.
  const ranked = active && result && "ids" in result ? result.ids : null;

  const visible = useMemo(() => {
    if (!topic && !ranked) return null;
    let list = essays;
    if (topic) list = list.filter((e) => e.topics.includes(topic));
    if (ranked) {
      // Intersect with the pills and keep the search ranking.
      const rank = new Map(ranked.map((id, i) => [id, i]));
      list = list.filter((e) => rank.has(e.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }
    return list;
  }, [essays, topic, ranked]);

  useEffect(() => {
    onChange(visible, ranked && visible && visible.length ? visible[0].id : null, topic);
  }, [visible, ranked, onChange, topic]);

  // Phones: the pills scroll in one row; fade the right edge while there's
  // more, and the left edge once scrolled (CSS reads these attributes).
  useLayoutEffect(() => {
    const el = pillRow.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2;
      const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      el.toggleAttribute("data-scrolled", left);
      el.toggleAttribute("data-end", end);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  let status = "";
  if (pending) status = "Reading the shelves…";
  else if (failed) status = failed;
  else if (visible && topic && !ranked) status = `${visible.length} ${visible.length === 1 ? "book" : "books"} in ${topic}`;
  else if (visible) status = `${visible.length} found`;

  return (
    <div className="w-full">
      <div className="relative">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
          placeholder="What are you looking for?"
          aria-label="Search the shelves"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
          // a dark, glassy pill: a faint top-lit fill and a thin light rim
          className="h-12 w-full rounded-full border border-foreground/30 bg-linear-to-b from-[#1a1a1a] to-[#222] pl-11 pr-11 font-sans text-[13px] uppercase tracking-[0.1em] sm:text-[14px] sm:tracking-[0.16em] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-colors placeholder:text-muted-foreground focus:border-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* topic pills: they wrap from 640px up; on phones, one snap-scrolling row
          with soft edge fades (the vertical padding keeps focus rings unclipped) */}
      <div
        ref={pillRow}
        role="group"
        aria-label="Filter by topic"
        data-testid="topic-pills"
        className="pill-row no-scrollbar -mx-4 mt-2.5 flex items-center gap-2 overflow-x-auto px-4 py-1.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      >
        <Pill active={topic === null} onClick={() => setTopic(null)} topic="All">
          All
        </Pill>
        {topics.map(([t]) => (
          <Pill key={t} active={topic === t} onClick={() => setTopic(topic === t ? null : t)} topic={t}>
            {t}
          </Pill>
        ))}
      </div>

      {/* search / filter status (the format row was removed; formats all stay on the shelf) */}
      <p aria-live="polite" className="mt-1.5 h-4 leading-4 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {status}
      </p>
    </div>
  );
}

function Pill({
  active,
  onClick,
  topic,
  children,
}: {
  active: boolean;
  onClick: () => void;
  topic: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid="topic-pill"
      data-topic={topic}
      aria-pressed={active}
      onClick={onClick}
      className={`shrink-0 snap-start whitespace-nowrap rounded-full border px-3.5 py-1.5 font-sans text-[12px] uppercase leading-[1.4] tracking-[0.14em] transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active
          ? "border-cream bg-cream text-background"
          : "border-foreground/40 text-foreground/90 hover:border-foreground/75 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
