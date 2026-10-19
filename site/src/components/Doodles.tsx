/**
 * Small hand-drawn marker doodles (inline SVG, decorative): a slightly wobbly ~1.5 px
 * stroke in the doodle colour, like the shelf's own outline (src/shelf3d/bake.ts).
 */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  vectorEffect: "non-scaling-stroke",
} as const;

/** The headline's curly arrow (the first drawing), flipped upside down so its head points down toward the books. */
export function CurlyArrow({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 64" className={className}>
      <g transform="matrix(1 0 0 -1 0 64)">
        <path {...stroke} d="M10.5 55.8c3.2-1.1 7.9-4.6 10.4-9.2 2.2-4 1.6-8.1-1.4-9.1-2.6-.9-4.6 1.7-3.2 4.1 1.7 2.9 6.6 2.7 10.3-.6 4.6-4.1 6.8-12.4 7.6-20.8.4-4.1.4-7.5.2-10.4" />
        <path {...stroke} d="M29.6 12.8c1.6-2.5 3.4-5 4.9-6.7 1.2 2.6 2.8 4.7 5 6.9" />
        <path {...stroke} d="M15.4 51.2c-1.9 1.9-3.7 3.4-5.6 4.8 2.4.8 4.9 1.4 7.6 1.9" />
      </g>
    </svg>
  );
}

/** An L-shaped bracket under the shelf (drawn for the left end: an arm under the plank, a leg, a foot turned out). */
export function Bracket({ mirror = false }: { mirror?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="block h-full w-full" style={mirror ? { transform: "scaleX(-1)" } : undefined}>
      <path {...stroke} d="M23 1.6c-3.4.5-7.6-.3-11.5.4-1.7.2-3.6-.2-5.2.3" />
      <path {...stroke} d="M6.6 2.1c.4 4.1-.3 8.4.3 12.6.2 2.2-.1 4.4.1 6.6" />
      <path {...stroke} d="M6.9 21.3c-1.6.3-3.3-.1-5 .2" />
    </svg>
  );
}

/** A small arrow pointing straight up (at the hovered book, from under the plank). */
export function UpArrow({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 24" className={className}>
      <path {...stroke} d="M8 22C7 16 9 10 8 3" />
      <path {...stroke} d="M5.6 8.5L8.0 3.0L11.9 7.6" />
    </svg>
  );
}

/**
 * "this one!": a hand-drawn ring round a book's foot and a handwritten note with a curved
 * arrow pointing at it (the Surprise me landing). Sized to the book's on-screen rect.
 */
export function ThisOne({ w, h }: { w: number; h: number }) {
  const rw = Math.max(46, w * 2.2);
  return (
    <>
      <svg aria-hidden="true" className="absolute overflow-visible" style={{ left: (w - rw) / 2, top: h - 14, width: rw, height: 26 }} viewBox="0 0 100 26" preserveAspectRatio="none">
        <path className="doodle-draw" pathLength={1} {...stroke} d="M52 22.6C33 24.4 6.1 22.4 3.4 15.2 1.1 9 21.2 4.2 47.6 3.9c26.8-.4 49.3 3.5 48.9 10.1-.5 6.6-22.9 9.8-48.4 9.6-7.4 0-13.5-.6-19.4-1.7" />
      </svg>
      <span className="absolute flex items-end whitespace-nowrap" style={{ left: w + 8, top: -38 }}>
        <svg aria-hidden="true" viewBox="0 0 44 30" className="h-[30px] w-[44px]">
          <path className="doodle-draw" pathLength={1} {...stroke} d="M42 7C30 5 16 10 5 26" />
          <path className="doodle-draw" pathLength={1} {...stroke} d="M11.4 23.2L5.0 26.0L5.3 19.0" />
        </svg>
        <span className="-ml-0.5 -translate-y-3 -rotate-6 font-display text-[26px] font-semibold leading-none">this one!</span>
      </span>
    </>
  );
}

/** A short curved arrow after the hint line, pointing up and to the left at the books. */
export function HintArrow({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 26" className={className}>
      <path {...stroke} d="M37 22C28 22 18 18 6 6" />
      <path {...stroke} d="M7.6 12.8L6.0 6.0L12.8 7.6" />
    </svg>
  );
}
