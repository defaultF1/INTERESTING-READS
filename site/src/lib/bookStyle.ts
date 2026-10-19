import { essays, type Essay } from "../data/essays";

/**
 * The books' jacket design, shared by the 3D shelf's bakes (src/shelf3d/bake.ts) and the
 * DOM cover (src/components/CoverFace.tsx): matte paper in one of a dozen flat colours,
 * one or two large soft wave shapes at the foot and/or the head in a companion colour,
 * a serif title (a few in tracked capitals), and the publication's initials in a thin circle.
 *
 * Everything is deterministic from the essay's id (a hash), and a book's colour never
 * repeats its neighbour's in the full, newest-first shelf order (bookends included), so
 * a book keeps its colour whatever the filter.
 */

/** The jacket colours. Change the palette here. */
export const PALETTE = {
  cobalt: "#1F3CC8",
  vermilion: "#E23A22",
  teal: "#0F8A7E",
  mint: "#1FA58A",
  violet: "#6A35D6",
  mustard: "#DDA21C",
  ink: "#161616",
  cream: "#EFE3CB",
  leaf: "#23914F",
  coral: "#EE7650",
  sky: "#3A82D8",
  plum: "#84308A",
} as const;
type Name = keyof typeof PALETTE;
const NAMES = Object.keys(PALETTE) as Name[];

/** Issue bookends: short mustard books (the "#N" is dark ink). */
export const MARKER_COLOUR = PALETTE.mustard;
export const MARKER_INK = "#1A1A1A";

/** The wave colours that sit well on each base (a neighbouring or a contrasting hue). */
const COMPANIONS: Record<Name, Name[]> = {
  cobalt: ["violet", "sky", "coral", "mint"],
  vermilion: ["coral", "mustard", "plum", "cream"],
  teal: ["mint", "mustard", "coral", "cream"],
  mint: ["teal", "cream", "cobalt", "mustard"],
  violet: ["plum", "sky", "coral", "mustard"],
  mustard: ["vermilion", "cream", "teal", "plum"],
  ink: ["mustard", "coral", "mint", "vermilion"],
  cream: ["coral", "violet", "cobalt", "mint", "vermilion"],
  leaf: ["mint", "mustard", "teal", "cream"],
  coral: ["vermilion", "mustard", "plum", "cream"],
  sky: ["cobalt", "cream", "mint", "coral"],
  plum: ["violet", "coral", "mustard", "vermilion"],
};

const INK_LIGHT = "#F6F1E7";
const INK_DARK = "#1A1A1A";

/**
 * A soft wave across the jacket: the region between the foot (or the head) and a smooth
 * edge, in unit coordinates (x 0..1 across, y 0..1 down). The edge runs from (0, y0) to
 * (1, y1) through two cubic segments meeting at (xm, ym).
 */
export type Wave = {
  at: "foot" | "head";
  colour: string;
  y0: number;
  xm: number;
  ym: number;
  y1: number;
  /** how far the tangents reach (0..1 of a segment): rounder or flatter swells */
  bend: number;
};

export type BookStyle = {
  base: string;
  /** the title's colour on the base */
  ink: string;
  /** "serif": the display serif in sentence case; "caps": tracked capitals */
  title: "serif" | "caps";
  waves: Wave[];
  /** the foot wave's top edge (highest point, unit y), 1 without one */
  footTop: number;
  /** the head wave's bottom edge (lowest point, unit y), 0 without one */
  headBottom: number;
  /** the colour under the author and the initials (the foot wave's, or the base) */
  footColour: string;
  footInk: string;
  headColour: string;
  headInk: string;
  /** the accent for a ribbon / the 3D headband */
  accent: string;
};

function hash(t: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
function rng(seed: number) {
  let x = seed || 7;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string) {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Cream or near-black lettering, whichever reads better on `bg` (cream when it's close). */
export function inkFor(bg: string) {
  return contrast(INK_LIGHT, bg) * 1.15 >= contrast(INK_DARK, bg) ? INK_LIGHT : INK_DARK;
}

/** The base colour per id, in the full shelf order: hashed, never the same as the item beside it. */
const BASES = new Map<string, Name>();
{
  let prev: Name | null = null;
  let prev2: Name | null = null;
  let issue = -1;
  for (const e of essays) {
    const n = Math.max(...e.issues);
    // a bookend (mustard) stands before each issue's first book
    if (n !== issue) {
      issue = n;
      prev2 = prev;
      prev = "mustard";
    }
    const h = hash(e.id, 11);
    let k = h % NAMES.length;
    // (the one before last too, so three in a row are three colours)
    while (NAMES[k] === prev || NAMES[k] === prev2) k = (k + 1 + (h >>> 8) % 5) % NAMES.length;
    BASES.set(e.id, NAMES[k]);
    prev2 = prev;
    prev = NAMES[k];
  }
}

const cache = new Map<string, BookStyle>();

/** The jacket of one book (memoised). */
export function bookStyle(e: Essay): BookStyle {
  const hit = cache.get(e.id);
  if (hit) return hit;
  const r = rng(hash(e.id, 29));
  const name = BASES.get(e.id) ?? NAMES[hash(e.id, 11) % NAMES.length];
  const base: string = PALETTE[name];
  const comp = COMPANIONS[name];
  const first = Math.floor(r() * comp.length) % comp.length;
  const waves: Wave[] = [];
  const roll = r();
  const foot = roll < 0.82;
  const head = roll >= 0.82 || r() < 0.38;
  let footTop = 1;
  let headBottom = 0;
  let footColour = base;
  let headColour = base;
  // the foot takes one companion, the head the next (two waves are never one colour)
  if (foot) {
    // the edge sits 30-40 % up from the foot, swelling up or down in the middle
    const lo = 0.6 + r() * 0.1;
    const y0 = lo + r() * 0.12;
    const y1 = lo + r() * 0.12;
    const ym = Math.min(y0, y1) + (r() - 0.55) * 0.14;
    const w: Wave = { at: "foot", colour: PALETTE[comp[first]], y0, xm: 0.3 + r() * 0.4, ym: Math.max(0.58, Math.min(0.82, ym)), y1, bend: 0.35 + r() * 0.3 };
    waves.push(w);
    footTop = Math.min(w.y0, w.ym, w.y1);
    footColour = w.colour;
  }
  if (head) {
    // a smaller swell from the head, never past ~13 %
    const y0 = 0.04 + r() * 0.08;
    const y1 = 0.04 + r() * 0.08;
    const ym = Math.max(0.03, Math.min(0.13, Math.max(y0, y1) + (r() - 0.4) * 0.06));
    const colour = PALETTE[comp[(first + (foot ? 1 : 0)) % comp.length]];
    const w: Wave = { at: "head", colour, y0, xm: 0.3 + r() * 0.4, ym, y1, bend: 0.35 + r() * 0.3 };
    waves.push(w);
    headBottom = Math.max(w.y0, w.ym, w.y1);
    headColour = w.colour;
  }
  const style: BookStyle = {
    base,
    ink: inkFor(base),
    title: r() < 0.85 ? "serif" : "caps",
    waves,
    footTop,
    headBottom,
    footColour,
    footInk: inkFor(footColour),
    headColour,
    headInk: inkFor(headColour),
    accent: waves[0]?.colour ?? base,
  };
  cache.set(e.id, style);
  return style;
}

type PathSink = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void;
  closePath(): void;
};

/** Trace a wave's soft edge alone, left to right (for feathering it). */
export function traceWaveEdge(p: Omit<PathSink, "closePath" | "lineTo">, wv: Wave, w: number, h: number) {
  const X = (x: number) => x * w;
  const Y = (y: number) => y * h;
  // two cubic segments with horizontal tangents at the middle point (a soft swell)
  const s1 = wv.xm * wv.bend;
  const s2 = (1 - wv.xm) * wv.bend;
  p.moveTo(X(0), Y(wv.y0));
  p.bezierCurveTo(X(s1), Y(wv.y0), X(wv.xm - s1), Y(wv.ym), X(wv.xm), Y(wv.ym));
  p.bezierCurveTo(X(wv.xm + s2), Y(wv.ym), X(1 - s2), Y(wv.y1), X(1), Y(wv.y1));
}

/** Trace a wave's region on a w × h face (a canvas context, or the SVG path builder below). */
export function traceWave(p: PathSink, wv: Wave, w: number, h: number) {
  const edge = wv.at === "foot" ? 1 : 0;
  p.moveTo(0, edge * h);
  p.lineTo(0, wv.y0 * h);
  traceWaveEdge({ moveTo: () => {}, bezierCurveTo: (a, b, c, d, x, y) => p.bezierCurveTo(a, b, c, d, x, y) }, wv, w, h);
  p.lineTo(w, edge * h);
  p.closePath();
}

/** a + (b − a)·t for two #rrggbb colours, as #rrggbb. */
export function mixHex(a: string, b: string, t: number) {
  const c = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** The same region as an SVG path's `d`. */
export function wavePathD(wv: Wave, w: number, h: number): string {
  let d = "";
  const f = (n: number) => +n.toFixed(2);
  traceWave(
    {
      moveTo: (x, y) => (d += `M${f(x)} ${f(y)}`),
      lineTo: (x, y) => (d += `L${f(x)} ${f(y)}`),
      bezierCurveTo: (a, b, c, e, x, y) => (d += `C${f(a)} ${f(b)} ${f(c)} ${f(e)} ${f(x)} ${f(y)}`),
      closePath: () => (d += "Z"),
    },
    wv,
    w,
    h,
  );
  return d;
}
