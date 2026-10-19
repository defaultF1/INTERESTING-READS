import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { readsLabel } from "../lib/essayMeta";
import { HintArrow } from "./Doodles";
import type { ShelfEngine3D } from "../shelf3d/engine";

const touchDevice = () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
/** The caption keeps this far from the page's edges and from the Pause / Surprise buttons (px). */
const GUTTER = 16;
const BUTTON_GAP = 14;

/**
 * The caption under the shelf (replaces the guide's floating hover card): the hovered /
 * keyboard-active book's title and publication · issue, set directly under that book (centred
 * on it, kept inside the page's gutters and clear of the buttons; the engine's little arrow
 * points from it up to the book), or a hint when nothing is hovered. The row keeps its height,
 * so nothing below moves. For keyboard and touch browsing the details are also announced
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
    const w = el.offsetWidth;
    const left = Math.max(minL, Math.min(maxR - w, cx - w / 2));
    el.style.transform = `translate3d(${Math.round(left - rr.left)}px, 0, 0)`;
  };
  useLayoutEffect(place);
  useEffect(() => {
    engine.onHoverMarkMove = place;
    return () => {
      engine.onHoverMarkMove = () => {};
    };
  });

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
        <div ref={followRef} className="absolute left-0 top-0 w-max text-center will-change-transform">
          {item.kind === "book" ? (
            <div key={item.essay.id} className={fade} style={fadeStyle}>
              <p className="truncate font-display text-[27px] font-semibold leading-[1.05] text-foreground">{item.essay.title}</p>
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
              <p className="font-display text-[27px] font-semibold leading-[1.05]">Interesting reads #{item.issue}</p>
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
