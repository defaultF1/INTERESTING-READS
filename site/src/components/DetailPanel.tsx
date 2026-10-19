import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { Essay } from "../data/essays";
import { FORMAT_LABEL, readLabel, readsLabel } from "../lib/essayMeta";
import { bookStyle } from "../lib/bookStyle";
import { COVER_W } from "./bookFaces";
import { CoverFace } from "./CoverFace";
import { SketchOutline, SketchTable } from "./Sketch";

type Props = {
  ref?: Ref<HTMLDivElement>;
  /** The open essay, or null when the panel is folded. */
  essay: Essay | null;
  read: boolean;
  reduced: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** keyboard = closed with Enter/Space/Escape (focus then returns to the shelf). */
  onClose: (keyboard: boolean) => void;
  onSetRead: (id: string, read: boolean) => void;
  /**
   * The book itself: drawn in the page (the plain shelf, or before the 3D shelf is up), or
   * the 3D book flown here from the shelf, which lands in the slot the page keeps for it.
   */
  bookInDom: boolean;
  /** the id of the 3D book lying in the slot (null while it flies) */
  landed: string | null;
};

/** Content fades/rises in after the guide's 260ms panel delay. */
const PANEL_DELAY_MS = 260;
const FOLD_MS = 600;

function useViewportWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

/**
 * The reading desk: unfolds inline below the shelf (grid-template-rows
 * 0fr → 1fr). The opened book lies on a sketched charcoal table at a slight
 * angle; the details sit on a black note card traced in marker.
 */
export function DetailPanel({ ref, essay, read, reduced, onPrev, onNext, onClose, onSetRead, bookInDom, landed }: Props) {
  const open = essay !== null;
  const [shown, setShown] = useState<Essay | null>(essay);
  const [prevId, setPrevId] = useState<string | null>(essay?.id ?? null);
  const [mode, setMode] = useState<"enter" | "swap">("enter");
  /** Bumped each time the panel opens, so the desk's entrance replays. */
  const [session, setSession] = useState(0);
  const innerRef = useRef<HTMLDivElement>(null);

  // Keep the last essay on the desk while the panel folds away.
  const id = essay?.id ?? null;
  if (id !== prevId) {
    const swap = prevId !== null && id !== null;
    setMode(swap ? "swap" : "enter");
    if (!swap && id !== null) setSession((n) => n + 1);
    setPrevId(id);
    if (essay) setShown(essay);
  }

  // Once folded away, let the desk go (its content is kept only while the fold animates).
  useEffect(() => {
    if (open || !shown) return;
    const t = window.setTimeout(() => setShown(null), reduced ? 0 : FOLD_MS + 80);
    return () => window.clearTimeout(t);
  }, [open, shown, reduced]);

  // Bring the desk into view if it opened below the fold.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(
      () => innerRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }),
      reduced ? 0 : FOLD_MS + 40,
    );
    return () => window.clearTimeout(t);
  }, [open, reduced]);

  return (
    <div
      ref={ref}
      id="detail-panel"
      data-testid="detail-panel"
      data-open={open || undefined}
      className="detail-fold"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">
        {shown ? (
          <div ref={innerRef} className="mx-auto w-full max-w-5xl px-3 pb-6 pt-5 sm:px-8">
            <Desk
              key={session}
              essay={shown}
              read={read}
              mode={mode}
              reduced={reduced}
              onPrev={onPrev}
              onNext={onNext}
              onClose={onClose}
              onSetRead={onSetRead}
              bookInDom={bookInDom}
              landed={landed}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type DeskProps = Omit<Props, "essay" | "ref"> & { essay: Essay; mode: "enter" | "swap" };

function Desk({ essay, read, mode, reduced, onPrev, onNext, onClose, onSetRead, bookInDom, landed }: DeskProps) {
  const vw = useViewportWidth();
  const u = vw < 640 ? Math.min(1.3, (vw - 96) / COVER_W) : vw < 900 ? 1.3 : 1.5;
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [copiedFor, setCopiedFor] = useState(essay.id);
  if (copiedFor !== essay.id) {
    setCopiedFor(essay.id);
    setCopied("idle");
  }

  useEffect(() => {
    if (copied === "idle") return;
    const t = window.setTimeout(() => setCopied("idle"), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copyLink = async () => {
    const { origin, pathname, search } = window.location;
    const url = `${origin}${pathname}${search}#${encodeURIComponent(essay.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        setCopied(ok ? "ok" : "fail");
      } catch {
        setCopied("fail");
      }
    }
  };

  // The table: under the whole desk from 768px up (the book and the card both lie on it); on
  // phones, under the book only (the card follows below the table's legs). Its top is measured
  // from the layout, so the book always lies wholly inside it.
  const deskRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const wide = vw >= 768;
  // (one measurement for the table and the card's outline: a single extra commit on opening)
  const [box, setBox] = useState({ w: 0, h: 0, tableH: 0, cardW: 0, cardH: 0 });
  useLayoutEffect(() => {
    const d = deskRef.current;
    const b = bookRef.current;
    const c = cardRef.current;
    if (!d || !b || !c) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(d).paddingTop) || 18;
      const tableH = wide ? d.offsetHeight : b.getBoundingClientRect().bottom - d.getBoundingClientRect().top + pad;
      const next = { w: d.offsetWidth, h: d.offsetHeight, tableH: Math.round(tableH), cardW: c.offsetWidth, cardH: c.offsetHeight };
      setBox((o) => (o.w === next.w && o.h === next.h && o.tableH === next.tableH && o.cardW === next.cardW && o.cardH === next.cardH ? o : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(d);
    ro.observe(c);
    return () => ro.disconnect();
  }, [wide, essay.id]);
  const tableH = box.tableH;

  const markRead = () => onSetRead(essay.id, true);
  // The desk rises in once per opening; Previous/Next only cross-fade the
  // book and the card's text (the controls stay mounted, so focus stays put).
  const enter = reduced ? undefined : { animation: `rise 900ms cubic-bezier(0.16, 1, 0.3, 1) ${PANEL_DELAY_MS}ms both` };
  const swap = mode === "swap" && !reduced ? { animation: "fade-in 360ms ease-out both" } : undefined;

  // The table lies under the shelf's canvas (the 3D book lands on it) and the card with the
  // details lies over the canvas: two layers, rising in together.
  return (
    <div className="desk-wrap relative">
      <div aria-hidden="true" className="desk-surface" style={{ ...enter, height: tableH || "100%" }}>
        <SketchTable w={box.w} h={tableH} />
      </div>
      <div ref={deskRef} className="desk relative z-10" style={enter}>
        <div className="relative grid items-center gap-x-12 gap-y-20 md:grid-cols-[auto_minmax(0,1fr)]">
          <div ref={bookRef} key={`book-${essay.id}`} className="flex justify-center md:justify-start md:pl-2" style={swap}>
            {bookInDom ? <LyingBook essay={essay} read={read} u={u} /> : <DeskSlot essay={essay} u={u} landed={landed === essay.id} />}
          </div>

          <article ref={cardRef} className="note-card" aria-labelledby="detail-title">
            <SketchOutline w={box.cardW} h={box.cardH} r={16} seed={3} className="text-doodle/90" />
            <div key={`text-${essay.id}`} style={swap}>
              <p className="card-kicker font-sans text-[11.5px] uppercase tracking-[0.2em] text-foreground/85">
                {readsLabel(essay.issues)}
                {essay.publication ? <span> · {essay.publication}</span> : null}
                <Underline />
              </p>
              <h2
                id="detail-title"
                className="mt-4 font-display text-[clamp(2.2rem,4.6vw,3.3rem)] font-bold leading-[0.98] text-balance text-foreground"
                // (a long title sets smaller, so every desk fits the zone the page reserves for it)
                style={essay.title.length > 100 ? { fontSize: "clamp(1.8rem, 3.4vw, 2.35rem)" } : essay.title.length > 64 ? { fontSize: "clamp(2rem, 3.9vw, 2.75rem)" } : undefined}
              >
                {essay.title}
              </h2>
              <p className="mt-2 font-sans text-[12px] uppercase tracking-[0.16em] text-muted-foreground">{essay.author}</p>
              {essay.description ? (
                <p className="mt-3 max-w-[52ch] font-serif text-[16px] leading-relaxed text-foreground/90">{essay.description}</p>
              ) : null}

              <ul className="mt-5 flex flex-wrap gap-2" aria-label="Format and topics">
                <li className="doodle-tag text-muted-foreground">{FORMAT_LABEL[essay.format]}</li>
                {essay.topics.map((t) => (
                  <li key={t} className="doodle-tag">
                    {t}
                  </li>
                ))}
              </ul>
            </div>

            {/* Outside the keyed block: these keep focus across Previous / Next. */}
            <div className="mt-6">
              {essay.link ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <a
                    href={essay.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="read-link"
                    onClick={markRead}
                    className="inline-flex items-center rounded-full bg-cream px-6 py-2.5 font-sans text-[15px] uppercase tracking-[0.14em] text-background transition-colors hover:bg-cream/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {readLabel(essay)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <PointArrow className="-ml-1 h-[22px] w-[34px] text-doodle/85" />
                  {essay.linkType === "paid" && essay.freeCopy ? (
                    <a
                      href={essay.freeCopy}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="free-copy-link"
                      onClick={markRead}
                      className="font-sans text-[12px] uppercase tracking-[0.14em] text-foreground/90 underline decoration-foreground/40 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
                    >
                      Free archived copy
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">No longer available</p>
              )}
              <LinkNote essay={essay} />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11.5px] uppercase tracking-[0.14em]">
              {read ? (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <svg aria-hidden="true" viewBox="0 0 12 16" className="h-3.5 w-2.5 text-primary" fill="currentColor">
                    <path d="M0 0h12v16l-6-4.2L0 16z" />
                  </svg>
                  You&rsquo;ve read this
                </span>
              ) : null}
              {/* one persistent action button (focus survives the change); its
                  label says what it does, the text beside it says the state */}
              <button
                type="button"
                data-testid="read-toggle"
                data-state={read ? "read" : "unread"}
                onClick={() => onSetRead(essay.id, !read)}
                className="rounded uppercase text-muted-foreground underline decoration-foreground/30 underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {read ? "Mark unread" : "Mark as read"}
              </button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button type="button" data-testid="panel-prev" onClick={onPrev} className="panel-btn">
                ← Previous
              </button>
              <button type="button" data-testid="panel-next" onClick={onNext} className="panel-btn">
                Next →
              </button>
              <button type="button" data-testid="copy-link" onClick={copyLink} className="panel-btn">
                {copied === "ok" ? "Link copied" : copied === "fail" ? "Couldn't copy" : "Copy link"}
              </button>
              <span className="sr-only" aria-live="polite">
                {copied === "ok" ? "Link copied" : copied === "fail" ? "Couldn't copy the link" : ""}
              </span>
              <button type="button" data-testid="panel-close" onClick={(e) => onClose(e.detail === 0)} className="panel-btn">
                Shelve it
              </button>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

/** The kicker's hand-drawn underline. */
function Underline() {
  return (
    <svg aria-hidden="true" viewBox="0 0 200 8" preserveAspectRatio="none" className="mt-1.5 block h-[7px] w-[min(100%,26rem)] text-doodle/80">
      <path d="M1.5 4.6C38 3.2 84 2.6 128 3.4c23 .4 46 1.3 68.6 2.4M140 6.3c10-.9 22-1 34-.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A tiny curved arrow pointing back at the Read button. */
function PointArrow({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 26" className={className}>
      <path d="M37 4C30 4 20 8 6 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.9 19.0L6.0 20.0L8.1 13.3" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The place kept for the 3D book: the same box the drawn one takes, empty; the book flies
 * in from the shelf and lands exactly in it (a screen reader still gets the cover's name).
 */
function DeskSlot({ essay, u, landed }: { essay: Essay; u: number; landed: boolean }) {
  const W = COVER_W * u;
  const H = essay.height * u;
  const T = Math.min(26, Math.max(9, essay.width * 0.42 * u));
  return (
    <div className="lying-book relative" style={{ width: W + 18, height: H + T + 22 }}>
      <div data-testid="desk-slot" data-landed={landed || undefined} role="img" aria-label={`Cover of ${essay.title}`} className="absolute left-0 top-0" style={{ width: W, height: H }} />
    </div>
  );
}

function LinkNote({ essay }: { essay: Essay }) {
  let note: string | null = null;
  if (essay.linkType === "paid") note = "Paid · subscription needed";
  else if (essay.linkType === "wayback") note = "Archived copy · the original page is gone";
  else if (essay.linkType === "official_alt") note = "Original unavailable · official re-upload";
  else if (!essay.link) note = "The original was removed and no archived copy exists";
  if (!note) return null;
  return <p className="mt-3 font-sans text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">{note}</p>;
}

/**
 * The opened book lying on the desk at a slight angle: the Penguin-style
 * cover on top, the cream page block showing along its front edge, and a
 * soft shadow falling down-right (away from the top-left light).
 */
function LyingBook({ essay, read, u }: { essay: Essay; read: boolean; u: number }) {
  const W = COVER_W * u;
  const H = essay.height * u;
  const T = Math.min(26, Math.max(9, essay.width * 0.42 * u));
  const hard = essay.binding === "hardcover";
  return (
    <div className="lying-book relative" style={{ width: W + 18, height: H + T + 22 }}>
      <span aria-hidden="true" className="lying-shadow" style={{ width: W, height: H }} />
      <div className="lying-stage" style={{ width: W, height: H }}>
        <div className="lying-body" style={{ width: W, height: H }}>
          {/* page block's front edge, hanging below the cover; the boards'
              edges (cover colour) frame it, overhanging a little on hardcovers */}
          <span
            aria-hidden="true"
            className="lying-pages"
            style={{
              height: T,
              borderTop: `${Math.max(1.5, (hard ? 2.2 : 1.2) * u)}px solid ${bookStyle(essay).base}`,
              borderBottom: `${Math.max(1.5, (hard ? 2.2 : 1.2) * u)}px solid ${bookStyle(essay).base}`,
              paddingInline: hard ? 3 * u : 0,
            }}
          />
          <span className="lying-cover" role="img" aria-label={`Cover of ${essay.title}`}>
            <CoverFace essay={essay} showImage u={u} read={read} />
          </span>
        </div>
      </div>
    </div>
  );
}
