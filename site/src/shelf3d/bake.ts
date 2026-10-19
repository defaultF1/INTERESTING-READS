import type { Essay } from "../data/essays";
import { hexLum, inkOn, publisherMark, withAlpha } from "../lib/essayMeta";
import { COVER_W } from "../components/bookFaces";

/**
 * Canvas 2D baking for the WebGL shelf. Every face is drawn once into an
 * atlas page (2048²) after the fonts are ready, then uploaded with mipmaps.
 * The drawings port the CSS spine / Penguin-cover looks: band rules, vertical
 * debossed (or foil) title, author, publisher mark, wear; cover head band,
 * balanced serif title, framed plate, author · publication.
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

const FACE: Record<Essay["face"], string> = {
  serif: '"Cormorant Garamond", Georgia, serif',
  sans: '"Karla", system-ui, sans-serif',
  mono: '"Space Mono", ui-monospace, monospace',
};
const MONO = '"Space Mono", ui-monospace, monospace';
const SERIF = '"Cormorant Garamond", Georgia, serif';

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

// ---------------------------------------------------------------- spines

/**
 * Draw one spine face at density rho (texels per unit) at (ox, oy).
 * Unit space: w × h CSS px, origin top-left.
 */
export function drawSpine(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number) {
  const { width: w, height: h, spine, ink, face, caps, wear, finish } = e;
  const band = e.band ?? spine;
  const rule = Math.abs(hexLum(band) - hexLum(spine)) < 0.1 ? withAlpha(ink, 0.5) : band;
  const darkInk = hexLum(ink) < 0.5;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  ctx.fillStyle = spine;
  ctx.fillRect(0, 0, w, h);

  // material grain (lighting/roughness come from the 3D material)
  if (finish === "cloth") {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#000";
    for (let y = 0; y < h; y += 2.2) ctx.fillRect(0, y, w, 0.5);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#fff";
    for (let x = 0; x < w; x += 2.2) ctx.fillRect(x, 0, 0.5, h);
    ctx.globalAlpha = 1;
  } else {
    // fine speckle so flat colour reads as paper
    const n = Math.round((w * h) / (finish === "matte" ? 9 : 18));
    let seed = (e.id.charCodeAt(e.id.length - 1) * 9301 + 49297) % 233280;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    ctx.fillStyle = "#000";
    ctx.globalAlpha = finish === "matte" ? 0.07 : 0.035;
    for (let i = 0; i < n; i++) ctx.fillRect(rnd() * w, rnd() * h, 0.6, 0.6);
    ctx.globalAlpha = 1;
  }

  // head & foot rules
  const headTop = Math.round(h * 0.06);
  const footBottom = Math.round(h * 0.06);
  ctx.fillStyle = rule;
  ctx.fillRect(0, headTop, w, 2);
  ctx.fillRect(0, h - footBottom - 2, w, 2);
  if (w >= 22) {
    ctx.fillRect(0, headTop + 4, w, 1);
    ctx.fillRect(0, h - footBottom - 5, w, 1);
  }

  // lettering
  const showAuthor = w >= 44;
  const showMark = w >= 30;
  const regionTop = headTop + 13;
  const regionBottom = footBottom + 13 + (showMark ? 20 : 0);
  const regionLen = h - regionTop - regionBottom;
  const fit = showAuthor ? 0.34 : face === "serif" ? 0.5 : face === "sans" ? 0.4 : 0.36;
  const [minS, maxS] = face === "serif" ? [10, 17] : face === "sans" ? [8.5, 13.5] : [8, 12];
  let size = Math.min(maxS, Math.max(minS, w * fit));
  if (caps) size *= 0.82;
  const inkAlpha = 1 - wear * 0.55;
  const weight = face === "serif" ? "500" : "400";
  const letterEm = caps ? 0.14 : face === "mono" ? 0.02 : 0.01;
  const authorSize = Math.max(8, size * 0.62);
  const gap = Math.round(w * 0.1);
  const colTitle = size * 1.05;
  const colAuthor = showAuthor ? authorSize * 1.05 : 0;
  const total = colTitle + (showAuthor ? gap + colAuthor : 0);
  const x0 = (w - total) / 2;

  const vertical = (text: string, fontSize: number, colX: number, alpha: number, foil: boolean) => {
    ctx.save();
    ctx.font = `${weight} ${fontSize}px ${FACE[face]}`;
    setSpacing(ctx, letterEm, fontSize);
    const t = ellipsize(ctx, caps ? text.toUpperCase() : text, regionLen);
    const len = ctx.measureText(t).width;
    // rotate 90° clockwise (like vertical-rl): text runs top -> bottom,
    // centred in the region and on the column
    ctx.translate(colX, regionTop + (regionLen - len) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.globalAlpha = alpha;
    if (!foil) {
      // debossed: the top-left light catches the impression's lower-right lip
      ctx.fillStyle = darkInk ? "rgba(255,255,255,.3)" : "rgba(0,0,0,.42)";
      ctx.fillText(t, darkInk ? 0.5 : -0.4, darkInk ? -0.5 : 0.4);
      ctx.fillStyle = ink;
      ctx.fillText(t, 0, 0);
    } else {
      const g = ctx.createLinearGradient(0, -fontSize / 2, len, fontSize / 2);
      g.addColorStop(0, "#fbedb6");
      g.addColorStop(0.28, "#e2bd63");
      g.addColorStop(0.52, "#a77c2c");
      g.addColorStop(0.7, "#f2d98f");
      g.addColorStop(1, "#b78a35");
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillText(t, 0.3, -0.3);
      ctx.fillStyle = g;
      ctx.fillText(t, 0, 0);
    }
    ctx.restore();
  };
  vertical(e.title, size, x0 + colTitle / 2, inkAlpha, !!e.foil);
  if (showAuthor) vertical(e.author, authorSize, x0 + colTitle + gap + colAuthor / 2, inkAlpha * 0.78, false);

  if (showMark) {
    const mark = publisherMark(e.publication);
    ctx.font = `700 6.2px ${MONO}`;
    setSpacing(ctx, 0.04, 6.2);
    const mw = ctx.measureText(mark).width + 6;
    const mh = 10.2;
    const mx = (w - mw) / 2;
    const my = h - footBottom - 11 - mh;
    ctx.globalAlpha = inkAlpha * 0.85;
    ctx.strokeStyle = withAlpha(ink, 0.55);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.roundRect(mx, my, mw, mh, mh / 2);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(mark, w / 2, my + mh / 2 + 0.3);
    ctx.textAlign = "start";
    ctx.globalAlpha = 1;
  }

  // sun fade / rubbed edges
  if (wear > 0) {
    ctx.globalAlpha = wear;
    let g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(255,247,232,.75)");
    g.addColorStop(0.09, "rgba(255,247,232,0)");
    g.addColorStop(0.9, "rgba(255,247,232,0)");
    g.addColorStop(1, "rgba(255,247,232,.65)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, "rgba(255,247,232,.5)");
    g.addColorStop(0.16, "rgba(255,247,232,0)");
    g.addColorStop(0.84, "rgba(255,247,232,0)");
    g.addColorStop(1, "rgba(255,247,232,.45)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  // thin edge darkening so neighbours read as touching
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, "rgba(20,12,4,.38)");
  g.addColorStop(Math.min(0.5, 2.5 / w), "rgba(20,12,4,0)");
  g.addColorStop(Math.max(0.5, 1 - 3 / w), "rgba(20,12,4,0)");
  g.addColorStop(1, "rgba(20,12,4,.45)");
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
 * The Penguin-style front cover (same layout as the DOM CoverFace), drawn at
 * density rho at (ox, oy). `img` is the cover WebP if it has loaded.
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
  const { spine, ink, title } = e;
  const band = e.band ?? spine;
  const bandInk = inkOn(band);
  const accent = Math.abs(hexLum(band) - hexLum(spine)) < 0.12 ? withAlpha(ink, 0.55) : band;
  const issue = Math.max(...e.issues);
  const hasPlate = Boolean(e.cover);
  const PADX = 13;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  ctx.fillStyle = spine;
  ctx.fillRect(0, 0, W, H);
  let g: CanvasGradient = ctx.createRadialGradient(W * 0.28, H * 0.18, 0, W * 0.28, H * 0.18, W * 1.1);
  g.addColorStop(0, "rgba(255,255,255,.12)");
  g.addColorStop(0.62, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.12)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // head band
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, 15);
  ctx.fillStyle = bandInk;
  ctx.font = `400 5.2px ${MONO}`;
  setSpacing(ctx, 0.22, 5.2);
  ctx.textBaseline = "middle";
  ctx.fillText("INTERESTING READS", PADX, 7.8);
  const nTxt = `Nº ${issue}`.toUpperCase();
  ctx.textAlign = "right";
  ctx.fillText(nTxt, W - PADX, 7.8);
  ctx.textAlign = "start";

  // title
  const len = title.length;
  let titleSize = len <= 18 ? 19 : len <= 34 ? 17 : len <= 56 ? 15 : len <= 84 ? 13 : 11.5;
  if (!hasPlate) titleSize *= 1.15;
  const maxLines = len > 84 ? 6 : hasPlate ? 4 : 5;
  ctx.font = `500 ${titleSize}px ${SERIF}`;
  setSpacing(ctx, -0.005, titleSize);
  const lines = balancedLines(ctx, title, W - PADX * 2, maxLines);
  const lh = titleSize * 1.04;
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let y = 15 + 12;
  for (const l of lines) {
    ctx.fillText(l, W / 2, y + lh * 0.8);
    y += lh;
  }
  // rule
  y += 7;
  ctx.fillStyle = accent;
  ctx.fillRect(W / 2 - 9, y, 18, 1);
  y += 1;

  // foot text (author · publication), 2 lines max
  ctx.font = `400 5.3px ${MONO}`;
  setSpacing(ctx, 0.14, 5.3);
  const foot = `${e.author}${e.publication && e.publication !== e.author ? ` · ${e.publication}` : ""}`.toUpperCase();
  let footLines = wrapLines(ctx, foot, W - PADX * 2);
  if (footLines.length > 2) footLines = [footLines[0], ellipsize(ctx, footLines.slice(1).join(" "), W - PADX * 2)];
  const footH = footLines.length * 5.3 * 1.5;
  const footTop = H - 5 - 9 - footH;

  // middle: plate or ornament, centred between the rule and the foot
  const midTop = y + 6;
  const midBottom = footTop - 6;
  if (hasPlate) {
    const ratio = e.coverRatio ?? 1.9;
    const maxPlateH = H * (len > 56 ? 0.29 : 0.35);
    const pw = Math.min(W - PADX * 2, maxPlateH * ratio);
    const ph = pw / ratio;
    const px = (W - pw) / 2;
    const py = midTop + Math.max(0, (midBottom - midTop - ph) / 2);
    // soft shadow under the plate
    const sg = ctx.createRadialGradient(W / 2 + 3, py + ph + 2, 0, W / 2 + 3, py + ph + 2, pw * 0.55);
    sg.addColorStop(0, "rgba(0,0,0,.32)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(px - 6, py + ph - 4, pw + 12, 12);
    ctx.fillStyle = withAlpha(band, 0.6);
    ctx.fillRect(px, py, pw, ph);
    if (img) {
      const iw = "naturalWidth" in img ? img.naturalWidth : img.width;
      const ih = "naturalHeight" in img ? img.naturalHeight : img.height;
      const s = Math.max(pw / iw, ph / ih);
      const sw = pw / s;
      const sh = ph / s;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, px, py, pw, ph);
    }
    ctx.strokeStyle = withAlpha(ink, 0.3);
    ctx.lineWidth = 0.75;
    ctx.strokeRect(px, py, pw, ph);
  } else {
    const cy = (midTop + midBottom) / 2;
    ctx.fillStyle = accent;
    ctx.fillRect(W / 2 - 17, cy - 30, 34, 1);
    ctx.font = `400 5px ${MONO}`;
    setSpacing(ctx, 0.3, 5);
    ctx.textAlign = "center";
    ctx.fillText("Nº", W / 2, cy - 20);
    ctx.font = `italic 300 46px ${SERIF}`;
    setSpacing(ctx, 0, 46);
    ctx.fillText(String(issue), W / 2, cy + 18);
    ctx.fillRect(W / 2 - 17, cy + 27, 34, 1);
    ctx.fillRect(W / 2 - 8, cy + 30.5, 16, 1);
  }

  // foot text
  ctx.font = `400 5.3px ${MONO}`;
  setSpacing(ctx, 0.14, 5.3);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.82;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  footLines.forEach((l, i) => ctx.fillText(l, W / 2, footTop + 5.3 * 1.5 * (i + 0.8)));
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
  // foot band
  ctx.fillStyle = band;
  ctx.fillRect(0, H - 5, W, 5);
  // hinge crease on the spine side
  g = ctx.createLinearGradient(0, 0, W * 0.07, 0);
  g.addColorStop(0, "rgba(0,0,0,.3)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W * 0.07, H);
  ctx.restore();
}

/**
 * A quick stand-in for a cover (its colour, head band and foot rule) for the
 * first frame: at the drum's edges covers are only seen at an angle, and the
 * full Penguin cover replaces it within a moment, in idle time.
 */
export function drawCoverPlain(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number) {
  const W = COVER_W;
  const H = e.height;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.fillStyle = e.spine;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = e.band ?? e.spine;
  ctx.fillRect(0, 0, W, 15);
  ctx.fillRect(0, H - 7, W, 7);
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
    const lines = balancedLines(ctx, e.title, W - 36, 4);
    const lh = size * 1.1;
    let y = h * 0.3;
    for (const line of lines) {
      ctx.fillText(line, W / 2 + 6, y);
      y += lh;
    }
    ctx.fillStyle = "rgba(55,42,30,0.3)";
    ctx.fillRect(W / 2 - 6 + 6, y + 2, 12, 0.8);
    ctx.font = `400 4.6px ${MONO}`;
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
  ctx.font = `400 3.9px ${MONO}`;
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
  const lines = balancedLines(ctx, e.title, W - 40, 4);
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
    ctx.font = `italic 400 5.6px ${SERIF}`;
    ctx.fillText(ellipsize(ctx, e.publication, W - 44), W / 2 + 6, y + 24);
  }
  ctx.font = `400 3.9px ${MONO}`;
  setSpacing(ctx, 0.18, 3.9);
  ctx.fillStyle = "rgba(55,42,30,0.6)";
  ctx.fillText(`INTERESTING READS${e.issues.length ? ` #${Math.max(...e.issues)}` : ""}`, W / 2 + 6, h - 16);
  ctx.restore();
}

/** The back cover, plainly: the cover's base colour, its bands, a blurb, the mark and a barcode. */
export function drawBackCover(ctx: CanvasRenderingContext2D, e: Essay, ox: number, oy: number, rho: number, h: number) {
  const W = COVER_W;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  ctx.beginPath();
  ctx.rect(0, 0, W, h);
  ctx.clip();
  ctx.fillStyle = e.spine;
  ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = e.band ?? e.spine;
  ctx.fillRect(0, 0, W, 15);
  ctx.fillRect(0, h - 7, W, 7);
  // a little wear toward the edges
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "rgba(0,0,0,0.12)");
  g.addColorStop(0.12, "rgba(0,0,0,0)");
  g.addColorStop(0.9, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, h);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = e.ink;
  ctx.font = `400 3.9px ${MONO}`;
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
  ctx.font = `400 3.4px ${MONO}`;
  ctx.textAlign = "center";
  ctx.fillText(String(900000 + (hashText(e.id) % 99999)).replace(/(\d{3})(?=\d)/g, "$1 "), bx + 22, by + 22);
  ctx.restore();
}

// --------------------------------------------------------------- bookends

/** Brass plate with the issue number engraved, at density rho. 22 × 30 units. */
export function drawPlate(ctx: CanvasRenderingContext2D, issue: number, ox: number, oy: number, rho: number) {
  const W = 22;
  const H = 30;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(rho, rho);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#f3e3a6");
  g.addColorStop(0.45, "#c9a253");
  g.addColorStop(1, "#7e5c22");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,248,214,.7)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0.4, H);
  ctx.lineTo(0.4, 0.4);
  ctx.lineTo(W, 0.4);
  ctx.stroke();
  ctx.strokeStyle = "rgba(70,44,8,.55)";
  ctx.beginPath();
  ctx.moveTo(W - 0.4, 0);
  ctx.lineTo(W - 0.4, H - 0.4);
  ctx.lineTo(0, H - 0.4);
  ctx.stroke();
  ctx.font = `700 8.5px ${MONO}`;
  setSpacing(ctx, -0.03, 8.5);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const t = `#${issue}`;
  ctx.fillStyle = "rgba(255,245,200,.65)";
  ctx.fillText(t, W / 2 + 0.5, H / 2 + 0.6);
  ctx.fillStyle = "#4a3410";
  ctx.fillText(t, W / 2, H / 2);
  ctx.restore();
}

// --------------------------------------------------- procedural textures

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d")! };
}

/** Wood grain strip (tiles along the plank). */
export function woodTexture() {
  const { c, ctx } = canvas(1024, 128);
  ctx.fillStyle = "#8a6440";
  ctx.fillRect(0, 0, 1024, 128);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 180; i++) {
    const y = rnd() * 128;
    const a = 0.03 + rnd() * 0.08;
    ctx.strokeStyle = rnd() > 0.5 ? `rgba(60,36,16,${a})` : `rgba(255,226,180,${a * 0.6})`;
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    const amp = 1 + rnd() * 3;
    const f = 0.004 + rnd() * 0.01;
    for (let x = 0; x <= 1024; x += 16) ctx.lineTo(x, y + Math.sin(x * f + i) * amp);
    ctx.stroke();
  }
  return c;
}

/** Walnut for the bookends: vertical grain over a warm mid-brown. */
export function walnutTexture() {
  const { c, ctx } = canvas(128, 512);
  const g = ctx.createLinearGradient(0, 0, 128, 0);
  g.addColorStop(0, "#6b4428");
  g.addColorStop(0.5, "#7c5232");
  g.addColorStop(1, "#673f25");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 512);
  let seed = 23;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const x = rnd() * 128;
    const a = 0.04 + rnd() * 0.12;
    ctx.strokeStyle = rnd() > 0.35 ? `rgba(40,22,10,${a})` : `rgba(255,214,160,${a * 0.5})`;
    ctx.lineWidth = 0.6 + rnd() * 1.8;
    ctx.beginPath();
    const amp = 0.6 + rnd() * 2.4;
    const f = 0.006 + rnd() * 0.02;
    for (let y = 0; y <= 512; y += 16) ctx.lineTo(x + Math.sin(y * f + i) * amp, y);
    ctx.stroke();
  }
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

/** Vertical fade for the plank's shadow on the wall below (alpha map, top = dark). */
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
