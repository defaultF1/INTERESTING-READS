import { useSyncExternalStore } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { readsLabel } from "../lib/essayMeta";
import type { ShelfEngine3D } from "../shelf3d/engine";

const touchDevice = () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

/**
 * The caption line under the shelf (replaces the guide's floating hover
 * card): what the hovered / keyboard-active book is, or a hint. For keyboard
 * and touch browsing the details are also announced politely (the focused
 * book's own label is only "title by author").
 */
export function ShelfCaption({ engine }: { engine: ShelfEngine3D }) {
  const snap = useSyncExternalStore(engine.subscribeHover, engine.getHoverSnapshot, engine.getHoverSnapshot);
  const reduced = usePrefersReducedMotion();
  const item = snap.gi === null ? null : engine.itemAt(snap.gi);
  const fade = reduced ? undefined : "animate-fade-in";
  const fadeStyle = reduced ? undefined : { animationDuration: "120ms" };
  const announce = snap.source === "kbd" || snap.source === "touch";

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
    <div className="min-h-[62px] min-w-0 flex-1" data-testid="shelf-caption">
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
      {item?.kind === "book" ? (
        <div key={item.essay.id} className={fade} style={fadeStyle}>
          <p className="truncate font-display text-[22px] font-medium leading-tight text-foreground">{item.essay.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <span>
              {[item.essay.author, item.essay.publication !== item.essay.author ? item.essay.publication : null, readsLabel(item.essay.issues)]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {item.essay.linkType === "paid" ? (
              <span className="rounded-full border border-primary/45 px-1.5 py-px text-[9.5px] tracking-[0.16em] text-primary">Paid</span>
            ) : null}
          </p>
          {snap.source === "touch" ? (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Tap again to open it</p>
          ) : null}
        </div>
      ) : item?.kind === "marker" ? (
        <div key={item.key} className={fade} style={fadeStyle}>
          <p className="font-display text-[22px] font-medium leading-tight">Interesting reads #{item.issue}</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {item.count} {item.count === 1 ? "read" : "reads"} · {touchDevice() ? "tap" : "click"} to jump to it
          </p>
        </div>
      ) : (
        <p className="pt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          {touchDevice()
            ? "Tap a book · tap again to open"
            : "Hover a book to see its cover · click to open it"}
        </p>
      )}
    </div>
  );
}
