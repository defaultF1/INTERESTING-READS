import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { readsLabel } from "../lib/essayMeta";
import { HintArrow } from "./Doodles";
import type { ShelfEngine3D } from "../shelf3d/engine";

const touchDevice = () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
/** The caption keeps this far from the page's edges and from the Pause / Surprise buttons (px). */
const GUTTER = 16;
const BUTTON_GAP = 14;
/** The caption keeps this far inside the visible viewport, and from the header above the shelf (px). */
const EDGE = 8;
/** Room for the arrow between a caption set above a book and the book's top (px), and the least it may have. */
const ARROW = 30;
const MIN_ARROW_ROOM = 12;

/**
 * The caption under the shelf (replaces the guide's floating hover card): the hovered /
 * keyboard-active book's title and publication · issue, set directly under that book (centred
 * on it, kept inside the page's gutters and clear of the buttons; the engine's little arrow
 * points from it up to the book), or a hint when nothing is hovered. Like a tooltip, it flips:
 * when under the shelf would run past the bottom of the visible viewport, it sits above the
 * book instead (clear of the header), the arrow pointing down at the book's top; in a window too
 * short even for that, it is pinned to the window's bottom edge on a dark backdrop. It is an
 * overlay: the row keeps its height, so nothing moves. For keyboard and touch browsing the details are also announced
 * politely (the focused book's own label is only "title by author").
 */
export function ShelfCaption({ engine }: { engine: ShelfEngine3D }) {
  const snap = useSyncExternalStore(engine.subscribeHover, engine.getHoverSnapshot, engine.getHoverSnapshot);
  const reduced = usePrefersReducedMotion();
  const item = snap.gi === null ? null : engine.itemAt(snap.gi);
  const fade = reduced ? undefined : "animate-fade-in";
  const fadeStyle = reduced ? undefined : { animationDuration: "120ms" };
  const announce = snap.source === "kbd" || snap.source === "touch";
  const rowRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLDivElement>(null);

  // centre the caption under the hovered book (the engine calls this when the book moves)
  const place = () => {
    const el = followRef.current;
    const row = rowRef.current;
    const x = engine.hoverX;
    if (!el || !row || !engine.stage || Number.isNaN(x)) return;
    const rr = row.getBoundingClientRect();
    const cx = engine.stage.getBoundingClientRect().left + x;
    const buttons = row.nextElementSibling?.getBoundingClientRect();
    const minL = GUTTER;
    const maxR = Math.min(window.innerWidth - GUTTER, buttons && buttons.width ? buttons.left - BUTTON_GAP : Infinity);
    el.style.maxWidth = `${Math.max(120, maxR - minL)}px`;
    // under the shelf if it fits in the visible viewport; else above the book (a little more
    // compact), clear of what's above the shelf: the search, the pills, their status line, the
    // header's buttons and the social links
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0;
    const vBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    el.removeAttribute("data-above");
    el.removeAttribute("data-pinned");
    const under = rr.top + el.offsetHeight <= vBottom - EDGE || Number.isNaN(engine.hoverTop);
    if (!under) el.setAttribute("data-above", "");
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.max(minL, Math.min(maxR - w, cx - w / 2));
    let y = 0;
    let mode: "under" | "above" | "none" = "under";
    let room = ARROW;
    if (!under) {
      const bookTop = engine.stage.getBoundingClientRect().top + engine.hoverTop;
      let clear = vTop + EDGE;
      const parts = document.querySelectorAll('header input, header [data-testid="topic-pill"], header button, header p[aria-live], nav[aria-label="AevyTV social links"]');
      for (const part of parts) {
        if (part instanceof HTMLParagraphElement && !part.textContent) continue;
        const b = part.getBoundingClientRect();
        if (b.height && b.bottom > clear && b.bottom < bookTop && b.left < left + w && b.right > left) clear = b.bottom + EDGE;
      }
      const top = Math.max(clear, bookTop - ARROW - h);
      if (bookTop - (top + h) >= MIN_ARROW_ROOM) {
        mode = "above";
        room = bookTop - (top + h);
        y = top - rr.top;
      } else {
        // a window too short for either: pinned to its bottom, over the books, on its own backdrop
        el.removeAttribute("data-above");
        el.setAttribute("data-pinned", "");
        mode = "none";
        const pw = el.offsetWidth;
        left = Math.max(minL, Math.min(maxR - pw, cx - pw / 2));
        y = vBottom - EDGE - el.offsetHeight - rr.top;
      }
    }
    engine.setHoverMarkMode(mode, room);
    el.style.transform = `translate3d(${Math.round(left - rr.left)}px, ${Math.round(y)}px, 0)`;
  };
  useLayoutEffect(place);
  useEffect(() => {
    engine.onHoverMarkMove = place;
    return () => {
      engine.onHoverMarkMove = () => {};
    };
  });
  // while something is hovered, the page scrolling or the viewport changing can flip it
  const hovering = item !== null;
  useEffect(() => {
    if (!hovering) return;
    const again = () => place();
    window.addEventListener("scroll", again, { passive: true });
    window.addEventListener("resize", again);
    window.visualViewport?.addEventListener("resize", again);
    window.visualViewport?.addEventListener("scroll", again);
    return () => {
      window.removeEventListener("scroll", again);
      window.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("scroll", again);
    };
  }, [hovering]);

  let spoken = "";
  if (announce && item?.kind === "book") {
    const e = item.essay;
    spoken = [e.publication !== e.author ? e.publication : null, readsLabel(e.issues), e.linkType === "paid" ? "paid" : null]
      .filter(Boolean)
      .join(", ");
  } else if (announce && item?.kind === "marker") {
    spoken = `Issue ${item.issue}, ${item.count} ${item.count === 1 ? "read" : "reads"}`;
  }

  return (
    <div ref={rowRef} className="relative min-h-[62px] min-w-0 flex-1" data-testid="shelf-caption">
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
      {item ? (
        <div ref={followRef} data-testid="caption-follow" className="absolute left-0 top-0 w-max text-center will-change-transform">
          {item.kind === "book" ? (
            <div key={item.essay.id} className={fade} style={fadeStyle}>
              <p className="caption-title truncate font-display text-[27px] font-semibold leading-[1.05] text-foreground">{item.essay.title}</p>
              <p className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-sans text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                <span>{[item.essay.publication || item.essay.author, readsLabel(item.essay.issues)].filter(Boolean).join(" · ")}</span>
                {item.essay.linkType === "paid" ? (
                  <span className="rounded-full border border-primary/45 px-1.5 py-px text-[9.5px] tracking-[0.16em] text-primary">Paid</span>
                ) : null}
              </p>
              {snap.source === "touch" ? (
                <p className="mt-1 font-sans text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Tap again to open it</p>
              ) : null}
            </div>
          ) : (
            <div key={item.key} className={fade} style={fadeStyle}>
              <p className="caption-title font-display text-[27px] font-semibold leading-[1.05]">Interesting reads #{item.issue}</p>
              <p className="mt-1 font-sans text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {item.count} {item.count === 1 ? "read" : "reads"} · {touchDevice() ? "tap" : "click"} to jump to it
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="pt-2 font-sans text-[12px] uppercase tracking-[0.2em] text-muted-foreground">
          {touchDevice() ? "Tap a book to see its name · tap again to open" : "Hover a book to see its name · click to open · hold to drag"}
          <HintArrow className="ml-2 inline-block h-[20px] w-[31px] -translate-y-[4px] align-middle text-doodle/80" />
        </p>
      )}
    </div>
  );
}
