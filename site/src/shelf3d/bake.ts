import type { Essay } from "../data/essays";
import { publisherMark, withAlpha } from "../lib/essayMeta";
import { MARKER_COLOUR, MARKER_INK, bookStyle, mixHex, traceWave, traceWaveEdge, type BookStyle } from "../lib/bookStyle";
import { COVER_W } from "../components/bookFaces";
import { FONT } from "./fonts";

/**
 * Canvas 2D baking for the WebGL shelf. Every face is drawn once into an
 * atlas page (2048²) after the fonts are ready, then uploaded with mipmaps.
 * The jackets are matte paper (src/lib/bookStyle.ts: a flat colour and soft
 * wave shapes): a spine with its title, author and initials in a circle; a
 * cover with the serif title, the essay's image as an inset panel, author ·
 * publication; the pages inside. Plus the issue markers' "#N" and the shelf's
 * hand-drawn outline. The faces are FONT (src/shelf3d/fonts.ts).
 */

const ATLAS = 2048;
const PAD = 2;

export type Slot = { page: number; x: number; y: number; w: number; h: number };
type UvRect = [number, number, number, number]; // u0, v0, uw, vh (v from top; flipY = false)

export function uvOf(s: Slot, size = ATLAS): UvRect {
  return [(s.x + 0.5) / size, (s.y + 0.5) / size, (s.w - 1) / size, (s.h - 1) / size];
}

/**
 * Shelf-packs face rectangles into square atlas pages. A page's canvas only
 * gives its texture a size (no 2D context, so no memory): faces are drawn in
 * a small scratch canvas and uploaded rectangle by rectangle.
 */
export class AtlasPacker {
  pages: { canvas: HTMLCanvasElement; x: number; y: number; rowH: number }[] = [];
  readonly size: number;
  constructor(size = ATLAS) {
    this.size = size;
  }
  private addPage() {
    const canvas = document.createElement("canvas");
    canvas.width = this.size;
    canvas.height = this.size;
    this.pages.push({ canvas, x: 0, y: 0, rowH: 0 });
  }
  /** Slots start on multiples of 8 texels, so a face's first mip levels line up with the page's. */
  alloc(w: number, h: number): Slot {
    const S = this.size;
    const al = (n: number) => Math.ceil(n / 8) * 8;
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (!this.pages.length) this.addPage();
    let p = this.pages[this.pages.length - 1];
    if (al(p.x) + w + PAD > S) {
      p.x = 0;
      p.y = al(p.y + p.rowH + PAD);
      p.rowH = 0;
    }
    if (p.y + h + PAD > S) {
      this.addPage();
      p = this.pages[this.pages.length - 1];
    }
    const slot = { page: this.pages.length - 1, x: al(p.x), y: p.y, w, h };
    p.x = slot.x + w + PAD;
    p.rowH = Math.max(p.rowH, h);
    return slot;
  }
}

/**
 * Run work as fast as possible in ~`slice` ms chunks, yielding to the browser
 * between them (a MessageChannel hop, not an idle callback: at startup the
 * page is never idle, and the first view must bake now).
 */
export function fastLoop(work: () => boolean, slice = 10): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const step = () => {
      const t0 = performance.now();
      do {
        if (!work()) {
          ch.port1.onmessage = null;
          resolve();
          return;
        }
      } while (performance.now() - t0 < slice);
      ch.port2.postMessage(0);
    };
    ch.port1.onmessage = step;
    step();
  });
}

/**
 * Run work in idle slices: up to `budget` ms of the browser's real idle time,
 * or a short `forced` slice when the idle callback times out (a shelf that
 * animates every frame leaves no idle time), so frames never get long.
 */
export function idleLoop(work: () => boolean, budget = 6, forced = Math.min(budget, 2.5)): Promise<void> {
  return new Promise((resolve) => {
    const hasRic = typeof window.requestIdleCallback === "function";
    const step = (deadline?: IdleDeadline) => {
      const t0 = performance.now();
      const slice = !deadline || deadline.didTimeout ? forced : Math.max(1, Math.min(budget, deadline.timeRemaining()));
      do {
        if (!work()) {
          resolve();
          return;
        }
      } while (performance.now() - t0 < slice);
      schedule();
    };
    const schedule = () => {
      if (hasRic) window.requestIdleCallback(step, { timeout: 80 });
      else window.setTimeout(() => step(), 0);
    };
    schedule();
  });
}

const SERIF = FONT.serif;
const SANS = FONT.sans;

function setSpacing(ctx: CanvasRenderingContext2D, em: number, size: number) {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = `${(em * size).toFixed(2)}px`;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid).trimEnd() + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

/** The jacket's flat colour and its wave shapes on a w × h face. */
/**
 * A small tile of paper grain (made once, pixel by pixel): fine light and dark specks, faint
 * vertical brush streaks and a few soft blotches, as translucent white / black over nothing,
 * so a plain blend only nudges the jacket's colour.
 */
let grainTile: HTMLCanvasElement | null = null;
function grain() {
  if (grainTile) return grainTile;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  // (a software canvas, like the scratch canvas the faces are drawn in: an accelerated tile would
  // be read back from the GPU at every face it fills)
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const r = seeded(97);
  const streak = new Float32Array(S);
  for (let x = 0; x < S; x++) streak[x] = (r() - 0.5) * 0.06;
  const blots = Array.from({ length: 7 }, () => ({ x: r() * S, y: r() * S, rad: 14 + r() * 26, v: (r() - 0.5) * 0.09 }));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // signed lightness: + lighter, - darker
      let v = streak[x] + (r() < 0.16 ? (r() - 0.5) * 0.5 : 0);
      for (const b of blots) {
        // (distance on the torus, so the tile repeats without a seam)
        const dx = Math.min(Math.abs(x - b.x), S - Math.abs(x - b.x));
        const dy = Math.min(Math.abs(y - b.y), S - Math.abs(y - b.y));
        const t = 1 - Math.hypot(dx, dy) / b.rad;
        if (t > 0) v += b.v * t * t;
      }
      const o = (y * S + x) * 4;
      const c8 = v > 0 ? 255 : 0;
      d[o] = d[o + 1] = d[o + 2] = c8;
      d[o + 3] = Math.min(255, Math.round(Math.abs(v) * 255));
    }
  g.putImageData(img, 0, 0);
  return (grainTile = c);
}

/**
 * The jacket on a w × h face: its colour with a faint tone from head to foot, the wave shapes
 * (each blending from a mix of both colours at its edge into its own, the edge feathered
 * softly, not cut out), and the paper's grain over all of it at device resolution.
 */
function jacket(ctx: CanvasRenderingContext2D, st: BookStyle, w: number, h: number) {
  ctx.fillStyle = st.base;
  ctx.fillRect(0, 0, w, h);
  let g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(255,255,255,0.05)");
  g.addColorStop(0.45, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(0,0,0,0.1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const wv of st.waves) {
    const foot = wv.at === "foot";
    const edge = (foot ? Math.min(wv.y0, wv.ym, wv.y1) : Math.max(wv.y0, wv.ym, wv.y1)) * h;
    const far = foot ? h : 0;
    const blend = mixHex(wv.colour, st.base, 0.4);
    g = ctx.createLinearGradient(0, edge, 0, far);
    g.addColorStop(0, blend);
    g.addColorStop(0.3, wv.colour);
    g.addColorStop(1, mixHex(wv.colour, "#000000", 0.1));
    ctx.beginPath();
    traceWave(ctx, wv, w, h);
    ctx.fillStyle = g;
    ctx.fill();
    // the feathered edge: the curve stroked soft in the two colours' mix, widest the faintest
    ctx.strokeStyle = mixHex(st.base, wv.colour, 0.5);
    ctx.lineCap = "round";
    for (const [lw, a] of [[6, 0.12], [3, 0.2], [1.3, 0.3]] as const) {
      ctx.globalAlpha = a;
      ctx.lineWidth = lw;
      ctx.beginPath();
      traceWaveEdge(ctx, wv, w, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // the paper's grain, one tile texel per device pixel
  const pat = ctx.createPattern(grain(), "repeat");
  if (pat) {
    const m = ctx.getTransform();
    pat.setTransform(new DOMMatrix([1 / m.a, 0, 0, 1 / m.d, 0, 0]));
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/** The publication's initials in a thin circle, centred at (cx, cy) (letters only: no marks). */
function initials(ctx: CanvasRenderingContext2D, e: Essay, cx: number, cy: number, d: number, ink: string) {
  let mark = publisherMark(e.publication);
  if (d < 14 || mark.length > 2) mark = mark.slice(0, 2);
  ctx.strokeStyle = withAlpha(ink, 0.8);
  ctx.lineWidth = Math.max(0.45, d * 0.045);
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.stroke();
  const size = d * (mark.length > 1 ? 0.34 : 0.42);
  ctx.font = `500 ${size}px ${SANS}`;
  setSpacing(ctx, 0.06, size);
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mark, cx + size * 0.03, cy + size * 0.04);
  ctx.textAlign = "start";
}

/**
 * Words into at most `max` lines of width `len`, balanced (null if they don't fit whole). The
 * greedy wrap decides whether they fit (cheap); only a fit is balanced.
 */
function fitLines(ctx: CanvasRenderingContext2D, text: string, len: number, max: number): string[] | null {
  const greedy = wrapLines(ctx, text, len);
  if (greedy.length > max || greedy.some((l) => ctx.measureText(l).width > len)) return null;
  return greedy.length > 1 ? balancedLines(ctx, text, len, max) : greedy;
}

/**
 * As many whole words as fit `n` lines of length `len` (the smallest size), the last line ending
 * in "…": a title is only ever cut at a word, never inside one (unless one word alone is too long).
 */
function cutAtWords(ctx: CanvasRenderingContext2D, text: string, len: number, n: number, setFace: (s: number) => void, size: number): string[] {
  setFace(size);
  const all = wrapLines(ctx, text, len);
  if (all.length <= n) return all;
  const lines = all.slice(0, n);
  let last = lines[n - 1].split(" ");
  while (last.length > 1 && ctx.measureText(`${last.join(" ")} …`).width > len) last = last.slice(0, -1);
  lines[n - 1] = last.length > 1 || ctx.measureText(`${last[0]} …`).width <= len ? `${last.join(" ").replace(/[\s,;:–—-]+$/, "")} …` : ellipsize(ctx, last[0], len);
  return lines;
}

/**
 * Letter across the jacket's colours: `draw(ink)` once per region (the base, and each wave), each
 * clipped to its region and given the ink that reads on it, so a line can run over a wave.
 */
function inRegions(ctx: CanvasRenderingContext2D, st: BookStyle, w: number, h: number, y0: number, y1: number, draw: (ink: string) => void) {
  // (only the waves the lettering's span [y0, y1] reaches: most titles cross none, drawn once)
  const waves = st.waves.filter((wv) =>
    wv.at === "foot" ? y1 > Math.min(wv.y0, wv.ym, wv.y1) * h : y0 < Math.max(wv.y0, wv.ym, wv.y1) * h,
  );
  if (!waves.length) {
    draw(st.ink);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  for (const wv of waves) traceWave(ctx, wv, w, h);
  ctx.clip("evenodd");
  draw(st.ink);
  ctx.restore();
  for (const wv of waves) {
    ctx.save();
    ctx.beginPath();
    traceWave(ctx, wv, w, h);
    ctx.clip();
    draw(wv.at === "foot" ? st.footInk : st.headInk);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- spines

/** How many spines were baked, and how many had their title cut with "…" (?debug checks). */
export const spineStats = { baked: 0, cut: 0 };

/**
 * Draw one spine face at density rho (texels per unit) at (ox, oy). Unit space: w × h CSS
 * px, origin top-left. A matte paper jacket: flat colour, the wave shapes at the foot and/or
 * the head, the title running down from the head (serif sentence case, or tracked capitals),
 * the author in tiny tracked capitals above the foot, the initials in a circle at the foot.
 */
export function drawSpine(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number) {
  const { width: w, height: h } = e;
  const st = bookStyle(e);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  jacket(ctx, st, w, h);

  // the foot: the initials' circle; above it the author (when there's room for both), and the
  // title from under the head down to there, across the waves (lettered in each region's ink)
  const d = Math.min(15, Math.max(9, w * 0.56));
  const circleY = h - 7 - d / 2;
  const circleTop = circleY - d / 2;
  const serif = st.title === "serif";
  const zoneTop = Math.max(h * 0.05, h * st.headBottom) + 8;
  const face = serif ? `400 %spx ${SERIF}` : `400 %spx ${SANS}`;
  const em = serif ? 0 : 0.18;
  const text = serif ? e.title : e.title.toUpperCase();
  const [minS, maxS] = serif ? [7, Math.max(7, Math.min(16, w * 0.52))] : [6, Math.max(6, Math.min(10.5, w * 0.36))];
  // under this size the author gives its room to the title
  const preferS = serif ? 9.5 : 7;
  // lines across the spine at a size: as many as its width holds (up to 2 on thin spines, 3 on wide ones)
  const linesFor = (s: number) => Math.max(1, Math.min(w >= 40 ? 3 : 2, Math.floor((w - 4) / (s * 1.08))));
  const setFace = (s: number) => {
    ctx.font = face.replace("%s", String(s));
    setSpacing(ctx, em, s);
  };
  /** The largest size (half units) at which the whole title fits a zone this long: a binary search. */
  const fitIn = (zone: number) => {
    let lo = 0;
    let hi = Math.floor((maxS - minS) * 2);
    let best: { size: number; lines: string[] } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = minS + mid / 2;
      setFace(s);
      const l = fitLines(ctx, text, zone, linesFor(s));
      if (l) {
        best = { size: s, lines: l };
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };
  const authorSize = Math.min(6, Math.max(4.4, w * 0.17));
  ctx.font = `500 ${authorSize}px ${SANS}`;
  setSpacing(ctx, 0.2, authorSize);
  const authorFull = e.author.toUpperCase();
  const authorLen = Math.min(ctx.measureText(authorFull).width, h * 0.3);
  let showAuthor = w >= 19;
  let zoneBottom = circleTop - 6 - (showAuthor ? authorLen + 8 : 0);
  let fit = fitIn(zoneBottom - zoneTop);
  if (showAuthor && (!fit || fit.size < preferS)) {
    // the whole title first: without the author line it may fit, or fit larger
    const alt = fitIn(circleTop - 6 - zoneTop);
    if (alt && (!fit || alt.size > fit.size)) {
      showAuthor = false;
      zoneBottom = circleTop - 6;
      fit = alt;
    }
  }
  let size = fit ? fit.size : minS;
  let lines = fit ? fit.lines : null;
  spineStats.baked++;
  if (!lines) {
    // not even at the smallest size: as many whole words as fit, the last line ending in "…"
    showAuthor = false;
    size = minS;
    spineStats.cut++;
    lines = cutAtWords(ctx, text, circleTop - 6 - zoneTop, linesFor(minS), (s) => setFace(s), minS);
  }
  setFace(size);
  const lh = size * 1.1;
  ctx.textBaseline = "middle";
  // rotated 90° clockwise (like vertical-rl): text runs top -> bottom, the first line on the right
  const span = Math.max(...lines.map((l) => ctx.measureText(l).width));
  inRegions(ctx, st, w, h, zoneTop, zoneTop + span, (ink) => {
    ctx.fillStyle = ink;
    lines!.forEach((l, i, all) => {
      ctx.save();
      ctx.translate(w / 2 + ((all.length - 1) / 2 - i) * lh, zoneTop);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(l, 0, 0);
      ctx.restore();
    });
  });

  if (showAuthor) {
    ctx.font = `500 ${authorSize}px ${SANS}`;
    setSpacing(ctx, 0.2, authorSize);
    const t = ellipsize(ctx, authorFull, authorLen + 0.5);
    const len = ctx.measureText(t).width;
    const bottom = circleTop - 5;
    inRegions(ctx, st, w, h, bottom - len, bottom, (ink) => {
      ctx.save();
      ctx.translate(w / 2, bottom - len);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = withAlpha(ink, 0.9);
      ctx.fillText(t, 0, 0);
      ctx.restore();
    });
  }
  initials(ctx, e, w / 2, circleY, d, st.footInk);

  // a rounded spine: soft shade into both edges, a faint sheen left of centre (the light is
  // top-left), so each book reads as a physical one beside its neighbours
  const g = ctx.createLinearGradient(0, 0, w, 0);
  const at = (px: number) => Math.min(0.45, px / w);
  g.addColorStop(0, "rgba(0,0,0,0.34)");
  g.addColorStop(at(2.5), "rgba(0,0,0,0.1)");
  g.addColorStop(at(w * 0.3), "rgba(255,255,255,0.07)");
  g.addColorStop(0.55, "rgba(255,255,255,0)");
  g.addColorStop(1 - at(4), "rgba(0,0,0,0.1)");
  g.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------- covers

function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width <= max || !line) line = t;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
/** Balanced wrapping (like CSS text-wrap: balance), clamped with an ellipsis. */
function balancedLines(ctx: CanvasRenderingContext2D, text: string, max: number, maxLines: number): string[] {
  const base = wrapLines(ctx, text, max);
  let lo = max * 0.4;
  let hi = max;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrapLines(ctx, text, mid).length <= base.length) hi = mid;
    else lo = mid;
  }
  let lines = wrapLines(ctx, text, hi);
  if (lines.length > maxLines) {
    lines = wrapLines(ctx, text, max).slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(ctx, lines[maxLines - 1] + " …", max);
  }
  return lines;
}

/**
 * The front cover (the same design as the DOM CoverFace), drawn at density rho at (ox, oy):
 * the jacket's colour and waves, "Interesting Reads" and "#N" at the head, the title in the
 * serif, the essay's image as an inset panel, author · publication in tracked capitals on the
 * foot. `img` is the cover WebP if it has loaded.
 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  e: Essay,
  ox: number,
  oy: number,
  rho: number,
  img: HTMLImageElement | ImageBitmap | null,
) {
  const W = COVER_W;
  const H = e.height;
  const st = bookStyle(e);
  const { title } = e;
  const issue = Math.max(...e.issues);
  const hasPlate = Boolean(e.cover);
  const PADX = 13;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  jacket(ctx, st, W, H);

  // head: the series and the issue, on the head's colour
  ctx.fillStyle = st.headInk;
  ctx.font = `500 5.2px ${SANS}`;
  setSpacing(ctx, 0.24, 5.2);
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.86;
  ctx.fillText("INTERESTING READS", PADX, 10);
  ctx.textAlign = "right";
  ctx.font = `${FONT.markerWeight} 7px ${SERIF}`;
  setSpacing(ctx, 0, 7);
  ctx.fillText(`#${issue}`, W - PADX, 10);
  ctx.textAlign = "start";
  ctx.globalAlpha = 1;

  // title, on the base under the head's wave
  const len = title.length;
  let titleSize = len <= 18 ? 19 : len <= 34 ? 17 : len <= 56 ? 15 : len <= 84 ? 13 : 11.5;
  if (!hasPlate) titleSize *= 1.15;
  const maxLines = len > 84 ? 6 : hasPlate ? 4 : 5;
  // the whole title, always: smaller until it fits its lines (down to 9), then more lines
  const titleMax = W - PADX * 2;
  const setTitle = (sz: number) => {
    ctx.font = `500 ${sz}px ${SERIF}`;
    setSpacing(ctx, -0.01, sz);
  };
  setTitle(titleSize);
  while (titleSize > 9 && wrapLines(ctx, title, titleMax).length > maxLines) setTitle((titleSize -= 0.5));
  const lines = balancedLines(ctx, title, titleMax, 99);
  const lh = titleSize * 1.06;
  ctx.fillStyle = st.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let y = Math.max(22, H * st.headBottom + 8);
  for (const l of lines) {
    ctx.fillText(l, W / 2, y + lh * 0.8);
    y += lh;
  }
  y += 4;

  // foot text (author · publication), 2 lines max, on the foot's colour
  ctx.font = `500 5.3px ${SANS}`;
  setSpacing(ctx, 0.16, 5.3);
  const foot = `${e.author}${e.publication && e.publication !== e.author ? ` · ${e.publication}` : ""}`.toUpperCase();
  let footLines = wrapLines(ctx, foot, W - PADX * 2);
  if (footLines.length > 2) footLines = [footLines[0], ellipsize(ctx, footLines.slice(1).join(" "), W - PADX * 2)];
  const footH = footLines.length * 5.3 * 1.5;
  const footTop = H - 10 - footH;

  // middle: the image panel, or the issue number large, between the title and the foot
  const midTop = y + 6;
  const midBottom = footTop - 8;
  if (hasPlate) {
    const ratio = e.coverRatio ?? 1.9;
    const maxPlateH = Math.min(H * (len > 56 ? 0.29 : 0.35), midBottom - midTop);
    const pw = Math.min(W - PADX * 2, Math.max(20, maxPlateH) * ratio);
    const ph = pw / ratio;
    const px = (W - pw) / 2;
    const py = midTop + Math.max(0, (midBottom - midTop - ph) / 2);
    ctx.fillStyle = withAlpha(st.accent, 0.7);
    ctx.fillRect(px, py, pw, ph);
    if (img) {
      const iw = "naturalWidth" in img ? img.naturalWidth : img.width;
      const ih = "naturalHeight" in img ? img.naturalHeight : img.height;
      const s = Math.max(pw / iw, ph / ih);
      const sw = pw / s;
      const sh = ph / s;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, px, py, pw, ph);
    }
    ctx.strokeStyle = withAlpha(st.ink, 0.35);
    ctx.lineWidth = 0.6;
    ctx.strokeRect(px, py, pw, ph);
  } else {
    const cy = (midTop + midBottom) / 2;
    ctx.fillStyle = st.ink;
    ctx.font = `${FONT.markerWeight} 44px ${SERIF}`;
    setSpacing(ctx, -0.02, 44);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`#${issue}`, W / 2, cy);
  }

  ctx.font = `500 5.3px ${SANS}`;
  setSpacing(ctx, 0.16, 5.3);
  ctx.fillStyle = st.footInk;
  ctx.globalAlpha = 0.9;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  footLines.forEach((l, i) => ctx.fillText(l, W / 2, footTop + 5.3 * 1.5 * (i + 0.8)));
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
  // the hinge's crease on the spine side
  const g = ctx.createLinearGradient(0, 0, W * 0.06, 0);
  g.addColorStop(0, "rgba(0,0,0,.24)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W * 0.06, H);
  ctx.restore();
}

/**
 * A quick stand-in for a cover (its colour and waves) for the first frame: at the drum's
 * edges covers are only seen at an angle, and the full cover replaces it within a moment,
 * in idle time.
 */
export function drawCoverPlain(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number) {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  jacket(ctx, bookStyle(e), COVER_W, e.height);
  ctx.restore();
}

/**
 * The inside of an open book: cream paper, and on the first page a faint
 * typeset title (the cover's typography, small) with the author · publication
 * line, so an open book still reads as that book. `plain` paints paper only
 * (the inside of a cover).
 */
export function drawInnerPage(ctx: CanvasRenderingContext2D, e: Essay | null, ox: number, oy: number, rho: number, h: number) {
  const W = COVER_W;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, h);
  ctx.clip();
  ctx.fillStyle = "#f1ebdd";
  ctx.fillRect(0, 0, W, h);
  // a little darker toward the gutter (x = 0 is the spine side)
  const g = ctx.createLinearGradient(0, 0, 26, 0);
  g.addColorStop(0, "rgba(90,70,45,0.16)");
  g.addColorStop(1, "rgba(90,70,45,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 26, h);
  if (e) {
    const len = e.title.length;
    const size = len <= 18 ? 12 : len <= 34 ? 10.5 : len <= 56 ? 9.5 : 8.5;
    ctx.fillStyle = "rgba(55,42,30,0.42)";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `500 ${size}px ${SERIF}`;
    const lines = balancedLines(ctx, e.title, W - 36, 99);
    const lh = size * 1.1;
    let y = h * 0.3;
    for (const line of lines) {
      ctx.fillText(line, W / 2 + 6, y);
      y += lh;
    }
    ctx.fillStyle = "rgba(55,42,30,0.3)";
    ctx.fillRect(W / 2 - 6 + 6, y + 2, 12, 0.8);
    ctx.font = `500 4.6px ${SANS}`;
    setSpacing(ctx, 0.14, 4.6);
    const foot = [e.author, e.publication !== e.author ? e.publication : null].filter(Boolean).join(" · ").toUpperCase();
    ctx.fillText(ellipsize(ctx, foot, W - 40), W / 2 + 6, y + 14);
  }
  ctx.restore();
}

// ----------------------------------------------------------------- pages

/** A small seeded generator for grain and paragraph variety. */
function seeded(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 7;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}
function hashText(t: string) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Cream paper with a faint grain and a little shade toward the gutter (x = 0 is the spine side). */
function paper(ctx: CanvasRenderingContext2D, W: number, h: number, seed: number) {
  ctx.fillStyle = "#f1ebdd";
  ctx.fillRect(0, 0, W, h);
  const r = seeded(seed);
  for (let i = 0; i < 520; i++) {
    const a = 0.025 + r() * 0.05;
    ctx.fillStyle = r() < 0.5 ? `rgba(120,95,60,${a.toFixed(3)})` : `rgba(255,255,255,${(a * 1.4).toFixed(3)})`;
    ctx.fillRect(r() * W, r() * h, 0.8 + r() * 1.4, 0.8 + r() * 1.2);
  }
  const g = ctx.createLinearGradient(0, 0, 26, 0);
  g.addColorStop(0, "rgba(90,70,45,0.16)");
  g.addColorStop(1, "rgba(90,70,45,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 26, h);
}
/** The essay's own sentences (description, title, author, publication), enough to fill a page. */
function pageSentences(e: Essay): string[] {
  const out: string[] = [];
  const desc = e.description
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?\u2026])\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
  out.push(...desc);
  out.push(`${e.title.replace(/[.!?\u2026]+$/, "")}.`);
  out.push(e.publication !== e.author ? `${e.author} writes in ${e.publication}.` : `By ${e.author}.`);
  if (e.issues.length) out.push(`First shared in Interesting Reads No. ${Math.max(...e.issues)}.`);
  return out.length ? out : [e.title];
}
/** A justified line: words spread to the measure (the last line of a paragraph stays ragged). */
function justify(ctx: CanvasRenderingContext2D, line: string, x: number, y: number, max: number, last: boolean) {
  const words = line.split(" ");
  if (last || words.length < 2) {
    ctx.fillText(line, x, y);
    return;
  }
  const wsum = words.reduce((a, w) => a + ctx.measureText(w).width, 0);
  const gap = (max - wsum) / (words.length - 1);
  let cx = x;
  for (const w of words) {
    ctx.fillText(w, cx, y);
    cx += ctx.measureText(w).width + gap;
  }
}

/**
 * A page of body text at density rho: justified paragraphs in a small serif, a running
 * header with the title and a page number at the foot, on cream paper with a faint grain.
 */
export function drawTextPage(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number, h: number, pageNo: number) {
  const W = COVER_W;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, h);
  ctx.clip();
  paper(ctx, W, h, hashText(e.id) + pageNo);
  const left = 18;
  const right = 11;
  const max = W - left - right;
  const size = 6.6;
  const lh = 8.4;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // running header and page number
  ctx.fillStyle = "rgba(55,42,30,0.55)";
  ctx.font = `500 3.9px ${SANS}`;
  setSpacing(ctx, 0.16, 3.9);
  ctx.fillText(ellipsize(ctx, e.title.toUpperCase(), max - 20), left, 13);
  setSpacing(ctx, 0, 3.9);
  ctx.font = `400 5px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.fillText(String(pageNo), left + max / 2, h - 7);
  ctx.textAlign = "left";
  // paragraphs: the essay's sentences, in a varying order, until the page is full
  const sentences = pageSentences(e);
  const r = seeded(hashText(e.id) * 31 + pageNo * 7);
  ctx.fillStyle = "rgba(48,38,28,0.84)";
  ctx.font = `400 ${size}px ${SERIF}`;
  let y = 24;
  let si = Math.floor(r() * sentences.length);
  let guard = 0;
  while (y < h - 16 && guard++ < 40) {
    const n = 2 + Math.floor(r() * 4);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(sentences[(si + i) % sentences.length]);
    si += n;
    const lines = wrapLines(ctx, "\u2003" + parts.join(" "), max);
    for (let i = 0; i < lines.length && y < h - 16; i++) {
      justify(ctx, lines[i], left, y, max, i === lines.length - 1);
      y += lh;
    }
    y += lh * 0.35;
  }
  ctx.restore();
}

/** The title page inside the front cover: title, author, publication, the issue line. */
export function drawTitlePage(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number, h: number) {
  const W = COVER_W;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, h);
  ctx.clip();
  paper(ctx, W, h, hashText(e.id) + 99);
  const len = e.title.length;
  const size = len <= 18 ? 13 : len <= 34 ? 11.5 : len <= 56 ? 10 : 9;
  ctx.fillStyle = "rgba(48,38,28,0.86)";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `500 ${size}px ${SERIF}`;
  const lines = balancedLines(ctx, e.title, W - 40, 99);
  const lh = size * 1.12;
  let y = h * 0.34;
  for (const line of lines) {
    ctx.fillText(line, W / 2 + 6, y);
    y += lh;
  }
  ctx.fillStyle = "rgba(48,38,28,0.5)";
  ctx.fillRect(W / 2 + 6 - 7, y + 3, 14, 0.8);
  ctx.font = `400 6px ${SERIF}`;
  ctx.fillStyle = "rgba(48,38,28,0.78)";
  ctx.fillText(ellipsize(ctx, e.author, W - 44), W / 2 + 6, y + 15);
  if (e.publication && e.publication !== e.author) {
    ctx.font = `400 5.6px ${SERIF}`;
    ctx.fillText(ellipsize(ctx, e.publication, W - 44), W / 2 + 6, y + 24);
  }
  ctx.font = `500 3.9px ${SANS}`;
  setSpacing(ctx, 0.18, 3.9);
  ctx.fillStyle = "rgba(55,42,30,0.6)";
  ctx.fillText(`INTERESTING READS${e.issues.length ? ` #${Math.max(...e.issues)}` : ""}`, W / 2 + 6, h - 16);
  ctx.restore();
}

/** The back cover, plainly: the jacket's colour and waves, a blurb and a barcode. */
export function drawBackCover(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number, h: number) {
  const W = COVER_W;
  const st = bookStyle(e);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, h);
  ctx.clip();
  jacket(ctx, st, W, h);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = st.ink;
  ctx.font = `500 3.9px ${SANS}`;
  setSpacing(ctx, 0.16, 3.9);
  ctx.fillText("INTERESTING READS", 14, 28);
  setSpacing(ctx, 0, 3.9);
  ctx.font = `400 6.4px ${SERIF}`;
  const max = W - 28;
  let y = 42;
  const text = [e.description, `${e.author}${e.publication && e.publication !== e.author ? ` \u00b7 ${e.publication}` : ""}`];
  for (const t of text) {
    const lines = wrapLines(ctx, t, max);
    for (const line of lines) {
      if (y > h - 44) break;
      ctx.fillText(line, 14, y);
      y += 8;
    }
    y += 6;
  }
  // barcode
  const bx = W - 58;
  const by = h - 36;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(bx, by, 44, 24);
  ctx.fillStyle = "#1b1b1b";
  const r = seeded(hashText(e.id) + 5);
  let x = bx + 4;
  while (x < bx + 40) {
    const w = 0.6 + r() * 1.4;
    ctx.fillRect(x, by + 3, w, 15);
    x += w + 0.6 + r() * 1.2;
  }
  ctx.font = `500 3.4px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillText(String(900000 + (hashText(e.id) % 99999)).replace(/(\d{3})(?=\d)/g, "$1 "), bx + 22, by + 22);
  ctx.restore();
}

// --------------------------------------------------------------- bookends

/** The label at the head of an issue marker (a short mustard book), at density rho. */
export const LABEL_W = 24;
export const LABEL_H = 34;
/**
 * The head of an issue marker's spine: the marker's own mustard, with "#N" in the serif in
 * dark ink near the top. It covers the spine face's full width at its top; the rest of the
 * marker is the same matte mustard, so the label's edge doesn't show.
 */
export function drawPlate(ctx: CanvasRenderingContext2D, issue: number, ox: number, oy: number, rho: number) {
  const W = LABEL_W;
  const H = LABEL_H;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.fillStyle = MARKER_COLOUR;
  ctx.fillRect(0, 0, W, H);
  const t = `#${issue}`;
  let size = 9;
  ctx.font = `${FONT.markerWeight} ${size}px ${SERIF}`;
  setSpacing(ctx, -0.02, size);
  const tw = ctx.measureText(t).width;
  if (tw > W - 5) {
    size *= (W - 5) / tw;
    ctx.font = `${FONT.markerWeight} ${size}px ${SERIF}`;
    setSpacing(ctx, -0.02, size);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = MARKER_INK;
  ctx.fillText(t, W / 2, 14);
  ctx.restore();
}

// --------------------------------------------------- procedural textures

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d")! };
}

/** The shelf's matte charcoal and its hand-drawn marker line (the doodles' off-white). */
export const SHELF_COLOUR = "#171717";
export const DOODLE = "#ede7dc";

/** A seamless wobble along a strip of `w` texels: a few integer-frequency sines. */
function wobble(seed: number, w: number) {
  const ph = [seed * 1.7, seed * 2.9, seed * 4.3, seed * 5.1];
  return (x: number, amp: number) => {
    const t = (x / w) * Math.PI * 2;
    return amp * (0.55 * Math.sin(3 * t + ph[0]) + 0.28 * Math.sin(7 * t + ph[1]) + 0.12 * Math.sin(13 * t + ph[2]) + 0.05 * Math.sin(29 * t + ph[3]));
  };
}

/**
 * The plank's front lip (tiles along it, 1024 units per repeat; v runs top -> bottom): matte
 * charcoal, traced along its top and bottom edges with a slightly wobbly marker line about
 * `px` CSS px thick, `k` CSS px per unit on screen (so the line is as thick on a phone).
 */
export function lipTexture(lip: number, k: number, px = 1.5) {
  const W = 2048;
  const H = 128;
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = SHELF_COLOUR;
  ctx.fillRect(0, 0, W, H);
  const perUnit = H / lip;
  const thick = Math.max(2.2, (px / Math.max(0.3, k)) * perUnit);
  ctx.strokeStyle = DOODLE;
  ctx.lineCap = "round";
  const line = (y: number, seed: number) => {
    const wb = wobble(seed, W);
    const th = wobble(seed + 3, W);
    // drawn in short pieces, the width breathing a little like a marker's
    for (let x = 0; x < W; x += 16) {
      ctx.lineWidth = thick * (1 + th(x, 0.22));
      ctx.beginPath();
      ctx.moveTo(x - 1, y + wb(x - 1, perUnit * 0.4));
      for (let xx = x + 4; xx <= x + 17; xx += 4) ctx.lineTo(xx, y + wb(xx, perUnit * 0.4));
      ctx.stroke();
    }
  };
  line(thick * 0.5 + perUnit * 0.6, 1);
  line(H - thick * 0.5 - perUnit * 0.7, 2);
  return c;
}

/** Soft blob for contact / turn shadows (grey on black: used as an alpha map). */
export function blobTexture() {
  const { c, ctx } = canvas(128, 128);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgb(255,255,255)");
  g.addColorStop(0.45, "rgb(140,140,140)");
  g.addColorStop(1, "rgb(0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return c;
}

/** Vertical fade for the books' soft shadow along the base (alpha map, top = dark). */
export function wallShadowTexture() {
  const { c, ctx } = canvas(4, 128);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "rgb(255,255,255)");
  g.addColorStop(0.45, "rgb(84,84,84)");
  g.addColorStop(1, "rgb(0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return c;
}
