/**
 * Hand-drawn marker outlines (decorative SVG, the doodle colour, ~1.5 px): a slightly wobbly
 * rounded box for cards, and the reading desk's table (top, front edge, legs). Drawn in CSS
 * px from the measured box (the desk measures it), so the stroke and the wobble stay the same
 * at every size.
 */

/** A small deterministic jitter (px) for point i of a drawing. */
function jit(seed: number, i: number, amp: number) {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}
const f = (n: number) => +n.toFixed(1);

/** A line from a to b that bows a little in the middle, as a pen does. */
function edge(ax: number, ay: number, bx: number, by: number, seed: number, i: number) {
  const mx = (ax + bx) / 2 + jit(seed, i, 1.1);
  const my = (ay + by) / 2 + jit(seed, i + 1, 1.1);
  return `Q${f(mx)} ${f(my)} ${f(bx)} ${f(by)}`;
}

/**
 * A rounded rectangle drawn in one stroke: corners of radius r, each side bowing slightly,
 * and the end overshooting the start a touch (where the pen lifted).
 */
export function roughRect(x: number, y: number, w: number, h: number, r: number, seed = 1) {
  const j = (i: number) => jit(seed, i, 0.9);
  const R = Math.min(r, w / 2, h / 2);
  let d = `M${f(x + R + 3)} ${f(y + j(0))}`;
  d += edge(x + R + 3, y + j(0), x + w - R, y + j(2), seed, 3);
  d += `Q${f(x + w + j(4))} ${f(y)} ${f(x + w + j(5))} ${f(y + R)}`;
  d += edge(x + w + j(5), y + R, x + w + j(6), y + h - R, seed, 7);
  d += `Q${f(x + w)} ${f(y + h + j(8))} ${f(x + w - R)} ${f(y + h + j(9))}`;
  d += edge(x + w - R, y + h + j(9), x + R, y + h + j(10), seed, 11);
  d += `Q${f(x + j(12))} ${f(y + h)} ${f(x + j(13))} ${f(y + h - R)}`;
  d += edge(x + j(13), y + h - R, x + j(14), y + R, seed, 15);
  d += `Q${f(x)} ${f(y + j(16))} ${f(x + R)} ${f(y + j(17))}`;
  d += `L${f(x + R + 9)} ${f(y + j(18) + 0.6)}`;
  return d;
}

const pen = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** A wobbly outline round its (positioned) parent, inset by half a stroke. */
export function SketchOutline({ w, h, r = 14, seed = 1, className = "" }: { w: number; h: number; r?: number; seed?: number; className?: string }) {
  if (!w || !h) return null;
  return (
    <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-visible ${className}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path {...pen} d={roughRect(1, 1, w - 2, h - 2, r, seed)} />
    </svg>
  );
}

/** The table's front edge (its thickness, below the top) and how far its legs reach below that. */
export const TABLE_EDGE = 13;
export const TABLE_LEGS = 34;

/**
 * The reading desk's table, w × h being its TOP (the book lies inside it): a slim matte
 * charcoal slab, its top and front edge traced in marker, two sketched legs at the front
 * corners and a glimpse of the back ones. Draws below its box (edge + legs).
 */
export function SketchTable({ w, h }: { w: number; h: number }) {
  if (!w || !h) return null;
  const e = TABLE_EDGE;
  const legs = TABLE_LEGS;
  const r = Math.min(22, w * 0.04);
  const H = h + e + legs;
  const leg = (x: number, dir: 1 | -1, seed: number) => {
    // a slim leg, a little tapered, splaying out a touch
    const top = h + e;
    const x2 = x + dir * 3;
    return (
      <path
        {...pen}
        d={`M${f(x)} ${f(top - 1)}C${f(x + jit(seed, 1, 0.6))} ${f(top + legs * 0.4)} ${f(x2)} ${f(top + legs * 0.7)} ${f(x2 + dir * 0.6)} ${f(top + legs)}M${f(x + dir * 9)} ${f(top - 1)}C${f(x + dir * 9)} ${f(top + legs * 0.4)} ${f(x2 + dir * 6.5)} ${f(top + legs * 0.7)} ${f(x2 + dir * 6)} ${f(top + legs)}`}
      />
    );
  };
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 overflow-visible text-doodle" width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
      {/* the slab: top and front edge, matte charcoal */}
      <path d={`M${r} 0H${w - r}Q${w} 0 ${w} ${r}V${h + e - 6}Q${w} ${h + e} ${w - 6} ${h + e}H6Q0 ${h + e} 0 ${h + e - 6}V${r}Q0 0 ${r} 0Z`} fill="#141414" />
      <path {...pen} d={roughRect(0.75, 0.75, w - 1.5, h, r, 5)} />
      {/* the front edge under the top */}
      <path {...pen} d={`M${f(2)} ${f(h - r * 0.4)}C${f(1)} ${f(h + e * 0.6)} ${f(4)} ${f(h + e)} ${f(r)} ${f(h + e + jit(7, 1, 0.5))}${edge(r, h + e, w - r, h + e + jit(7, 2, 0.6), 7, 3)}C${f(w - 4)} ${f(h + e)} ${f(w - 1)} ${f(h + e * 0.6)} ${f(w - 2)} ${f(h - r * 0.4)}`} />
      {leg(Math.max(14, w * 0.035), 1, 1)}
      {leg(w - Math.max(14, w * 0.035), -1, 2)}
    </svg>
  );
}
