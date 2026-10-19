import { essays as ALL_ESSAYS, type Essay } from "../data/essays";
import { PART_MARGIN, TURN } from "../components/bookFaces";
import { Drum, CAM_D } from "./curve";
import { BOOK_DEPTH, LIP, PLANK_FRONT, Row, type RowItem } from "./row";

/**
 * The shelf's motion + interaction engine (renderer-agnostic, no DOM per book).
 *
 *  - position model: `pos` = row coordinate at the viewport centre (fractional,
 *    unbounded for looping rows); drift / glides / momentum are time-based
 *  - hover is decided by COLUMN from the stable target layout (never from the
 *    moving geometry), so it can't flicker; clicks also check the height
 *  - turn + parting are eased tweens (cubic-bezier(0.16,1,0.3,1), 550ms)
 *  - the WebGL scene asks for poses each frame; React only hears about hover
 *    changes (caption) and activations
 */

export type HoverSource = "pointer" | "touch" | "kbd";
/** A book leaving the shelf: its arc offset from the view centre if it's on screen (it falls), else null (lands straight away). */
/** A book leaving the shelf: its screen arc offset when in view (else null) and its row x in the old row. */
export type LeaveInfo = { id: string; s: number | null; x: number | null };
/** The desk's book slot in the page (stage px): the DOM reserves it, the canvas lands the book in it. */
export type DeskRect = { cx: number; cy: number; w: number; h: number };
/** The ground (the 3D chunk registers it): the books off the shelf, and the one book on the desk. */
export interface GroundHook {
  /** Is this book off the shelf because of the topic / read filter (fallen, flying back, or never shown)? */
  has(id: string): boolean;
  /** Books outside the filter that are on neither the shelf nor the ground (a search had narrowed the shelf): off the shelf too. */
  ground(ids: string[]): void;
  apply(leaving: LeaveInfo[], returning: string[], reduced: boolean): void;
  /**
   * The desk's book: it leaves its slot (which stays empty) for the desk. `delay` ms before it
   * moves; `fast` for the hash-load (600 ms); `reduced` lands it at once.
   */
  toDesk(id: string, opts: { fast?: boolean; delay?: number; reduced: boolean }): void;
  /** Back to the exact slot (then the shelf draws it). */
  fromDesk(id: string, opts: { fast?: boolean; reduced: boolean }): void;
  /** Shelf books the ground is drawing (on the desk or flying): their slots stay empty. */
  hiddenIds(): string[];
  /** Where the desk's slot is (the page provides it; null while the desk is folded). */
  deskTarget: (() => DeskRect | null) | null;
  /** A book landed on the desk / left it (debug, tests). */
  onDesk: (id: string, on: boolean) => void;
  /** A book is flying to or from the desk (the page fades the caption's text meanwhile). */
  onFlying: (flying: boolean) => void;
}


export type Pose = { x: number; y: number; z: number; rotY: number; lean: number; turn: number };
export type ScreenRect = { left: number; top: number; width: number; height: number };

/** Drift speed in SCREEN px/s (converted to row units by the view scale). */
const DRIFT_PX_PER_S = 27;
const RESUME_AFTER_MS = 2500;
const RESUME_AFTER_LEAVE_MS = 700;
const LEAVE_GRACE_MS = 90;
/** a cover turning back closes in this long (faster than it opened: the next book's slot is wanted now) */
const CLOSE_MS = 180;
/**
 * The hover: a book lifts and slides this far out of the row, no turn (no cover shows until it
 * is opened). The lift is given in screen px at the shelf's front; the slide brings the book's
 * top (below eye level) down on screen by a few px, so the net lift seen is ~14 px.
 */
const HOVER_LIFT_PX = 18;
const HOVER_SLIDE = 0.38 * BOOK_DEPTH;
const HOVER_MS = 180;
const HOVER_BACK_MS = 120;
const DRAG_THRESHOLD = 5;
const TURN_RAD = (TURN.angle * Math.PI) / 180;
const FLING_TAU = 0.35; // s, momentum decay
const WHEEL_TAU = 0.11; // s, wheel smoothing
// A wheel sequence belongs to whoever took its previous event: a notch that follows a page-scrolling
// notch within this gap stays the page's even if the band has scrolled under the pointer meanwhile
const WHEEL_LATCH_MS = 150;
const CLICK_TOP_TOLERANCE = 30;

// Framing: the tallest book (over the whole library, so filters don't rescale
// the shelf) fills the stage between ~11% headroom (room for the hover lift
// and the turned cover) and the plank + lip, which sit on a thin band at the
// bottom. The eye is a little above the tallest book, so book tops and the
// plank's front strip show.
const MAX_BOOK_H = Math.max(...ALL_ESSAYS.map((e) => e.height));
const HEADROOM = 0.11;
const BOTTOM_BAND = 0.03;
const EYE_ABOVE = 70;
/** A turned cover keeps clear of the stage's soft side fades (7% each side, styles.css) plus this (px). */
const FIT_MARGIN = 10;
const SIDE_FADE = 0.07;
const FIT_TAU = 0.14; // s, the fit pan's easing
/** The entrance: books settle onto the plank from just above, staggered from the centre out. */
const ENTRANCE_MS = 320;
const ENTRANCE_STAGGER_MS = 140;
const ENTRANCE_DROP = 26;

/** Exact cubic-bezier easing (as CSS), here (0.16, 1, 0.3, 1). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const easeOutExpo = bezier(0.16, 1, 0.3, 1);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * "Surprise me": a heavy carousel. easeInQuad ramp-up (280ms) to a peak of
 * ≤ 2400 px/s, a cruise if needed, then a long soft easeOutQuart landing.
 * Velocity is continuous at every joint and it lands exactly on target.
 */
function spinCurve(D: number, peak = 2400) {
  const sign = Math.sign(D) || 1;
  const dist = Math.abs(D);
  const Ta = 0.28;
  const Td = 1.6;
  let vmax = peak;
  let Tc = dist / vmax - (Ta / 2 + Td / 4);
  if (Tc < 0) {
    Tc = 0;
    vmax = dist / (Ta / 2 + Td / 4);
  }
  const d1 = (vmax * Ta) / 2;
  const d2 = vmax * Tc;
  const T = Ta + Tc + Td;
  const f = (t: number) => {
    if (t <= 0) return 0;
    if (t < Ta) return (vmax * t * t) / (2 * Ta);
    if (t < Ta + Tc) return d1 + vmax * (t - Ta);
    const u = Math.min(1, (t - Ta - Tc) / Td);
    return d1 + d2 + ((vmax * Td) / 4) * (1 - Math.pow(1 - u, 4));
  };
  return { dur: T, at: (t: number) => sign * f(t), vmax };
}

type Glide = { from: number; to: number; t: number; dur: number; at: (t: number) => number; done?: () => void };

export class ShelfEngine3D {
  row: Row;
  readonly drum: Drum;

  // view (stage) metrics, cached on resize only. k = screen px per world unit
  // at the drum front; E = eye height above the plank (world); horizonY =
  // stage y of the eye level (may be above the stage).
  view = { w: 0, h: 0, frameH: 0, halfW: 0, k: 1, E: MAX_BOOK_H + EYE_ABOVE, horizonY: 70, d: CAM_D };

  /** The ground, when the 3D chunk provides one: the books off the shelf and the one on the desk. */
  ground: GroundHook | null = null;
  /** Books whose slot is held for them while they fly in from below (drawn by the ground). */
  hidden = new Set<string>();
  /** Bookends leaving the shelf (they shrink away where they stood). */
  leavingMarkers: { issue: number; v: number; s: number; at: number }[] = [];
  private enterMarkers = new Map<number, number>();
  // the shelf closing up / opening after a topic change: per item (k) offset, eased to 0
  private morphFrom = new Map<number, number>();
  // the copy (v) of each kept book that is held where it stood: a short looping row shows a
  // book more than once, and its other copies would stand where fallers and held books still
  // are, so they stay out until the row has closed up and then settle in from just above
  private heldV = new Map<number, number>();
  private morphAt = 0;
  private morphDelay = 0;
  private morphDur = 0;
  /** when the row closes up after the last morph (ms after it began; the ground times returns by it) */
  get morphDelayMs() {
    return this.morphDelay;
  }
  /** when the row has finished closing up (performance.now ms; 0 = never morphed) */
  get morphEndAt() {
    return this.morphAt ? this.morphAt + this.morphDelay + this.morphDur : 0;
  }

  pos = 0;
  /** How fast the shelf is moving (row units/s, smoothed). */
  speed = 0;
  /** When the entrance started (0 = none). */
  private entranceAt = 0;
  /** The fit pan: eases the shelf so a turned cover stays inside the stage. */
  private fit = 0;
  private fitTo = 0;
  private lastNow = 0;

  hovered: number | null = null;
  hoverSource: HoverSource | null = null;
  /** The book turned by hover (a hovered bookend keeps the last book turned). */
  /** the hover's lift tweens (0 resting .. 1 lifted and slid out): the hovered / keyboard / first-tapped book */
  private liftT = new Map<number, { from: number; to: number; p: number; dur: number }>();
  selected: number | null = null;

  /**
   * per virtual index: the cover's turn tween (eased `from` -> `to` over `p` 0..1, in `dur`
   * ms): every book turned, turning out or turning back is here, and the parting of the
   * row is read off these every frame, so the slots always hold exactly the covers showing
   */
  private turnT = new Map<number, { from: number; to: number; p: number; dur: number }>();

  userPaused = false;
  reduced = false;
  private pointerInside = false;
  private panelOpen = false;
  private dragging = false;
  private interactionUntil = 0;

  private glide: Glide | null = null;
  private flingV = 0;
  private wheelTarget: number | null = null;
  // the last two wheel events seen anywhere on the page (a passive capture listener) and whether the shelf took them
  private wheelAt = -1e9;
  private wheelOwned = false;
  private wheelPrevAt = -1e9;
  private wheelPrevOwned = false;
  private drag: { x: number; y: number; pos: number; moved: boolean; id: number; type: string; samples: [number, number][] } | null = null;
  private suppressClick = false;
  private lastPointerType = "mouse";
  private lastClientX = 0;
  private lastClientY = 0;
  private leaveTimer = 0;
  private resumeTimer = 0;
  private stage: HTMLElement | null = null;

  /** Wired by the page. */
  onActivate: (v: number) => void = () => {};
  /** Wired by the canvas: request a frame (R3F invalidate). */
  requestFrame: () => void = () => {};
  /** Wired by the canvas: the stage size changed (rebuild the room). */
  onResize: () => void = () => {};
  /** The DOM focus ring (positioned on the keyboard-highlighted book). */
  focusRing: HTMLElement | null = null;

  stats = { blankFrames: 0, frames: 0 };

  private hoverListeners = new Set<() => void>();
  private hoverSnap: { gi: number | null; source: HoverSource | null } = { gi: null, source: null };

  constructor(essays: Essay[]) {
    this.row = new Row(essays);
    this.drum = new Drum(720);
    this.pos = this.startPos();
  }

  // ----------------------------------------------------------------- setup

  /** Stage size changed (CSS px). */
  /** The canvas is w × h; the shelf is framed in its top `frameH` (the same as h unless a desk is open below). */
  resize(w: number, h: number, frameH = h) {
    const v = this.view;
    v.w = w;
    v.h = h;
    v.frameH = frameH;
    v.halfW = w / 2;
    const c = v.d / (v.d - PLANK_FRONT);
    v.E = MAX_BOOK_H + EYE_ABOVE;
    v.k = (frameH * (1 - HEADROOM - BOTTOM_BAND)) / ((v.E + LIP) * c - EYE_ABOVE);
    v.horizonY = frameH * (1 - BOTTOM_BAND) - v.k * (v.E + LIP) * c;
    this.drum.build(w / 2 / v.k);
    this.turnCentres.clear();
    this.partDirty = true;
    this.setPos(this.pos);
    this.onResize();
    this.requestFrame();
  }

  /** A new list (filter / search). Returns the selected id if it's still on the shelf. */
  setEssays(essays: Essay[]) {
    return this.setRow(new Row(essays));
  }
  setRow(row: Row) {
    const keepSel = this.selected !== null ? this.idOf(this.selected) : null;
    this.row = row;
    this.turnCentres.clear();
    this.morphFrom.clear();
    this.leavingMarkers = [];
    this.enterMarkers.clear();
    this.fit = this.fitTo = 0;
    this.glide = null;
    this.flingV = 0;
    this.wheelTarget = null;
    this.hovered = this.selected = null;
    this.hoverSource = null;
    this.turnT.clear();
    this.liftT.clear();
    this.pos = this.startPos();
    this.emitHover();
    this.requestFrame();
    return keepSel !== null && this.row.kOfId(keepSel) !== undefined ? keepSel : null;
  }

  /** Where a fresh shelf starts: newest issue near the left edge. */
  startPos() {
    if (!this.row.looping) return this.row.length / 2;
    return this.drum.sMax - 32;
  }

  attach(stage: HTMLElement): () => void {
    this.stage = stage;
    stage.addEventListener("pointerenter", this.onPointerEnter);
    stage.addEventListener("pointermove", this.onPointerMove);
    stage.addEventListener("pointerleave", this.onPointerLeave);
    stage.addEventListener("pointerdown", this.onPointerDown);
    stage.addEventListener("pointerup", this.onPointerUp);
    stage.addEventListener("pointercancel", this.onPointerCancel);
    stage.addEventListener("click", this.onClick);
    stage.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("wheel", this.onAnyWheel, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    return () => {
      stage.removeEventListener("pointerenter", this.onPointerEnter);
      stage.removeEventListener("pointermove", this.onPointerMove);
      stage.removeEventListener("pointerleave", this.onPointerLeave);
      stage.removeEventListener("pointerdown", this.onPointerDown);
      stage.removeEventListener("pointerup", this.onPointerUp);
      stage.removeEventListener("pointercancel", this.onPointerCancel);
      stage.removeEventListener("click", this.onClick);
      stage.removeEventListener("wheel", this.onWheel);
      window.removeEventListener("wheel", this.onAnyWheel, true);
      document.removeEventListener("visibilitychange", this.onVisibility);
      window.clearTimeout(this.leaveTimer);
      window.clearTimeout(this.resumeTimer);
      this.stage = null;
    };
  }

  // ----------------------------------------------------------- lookups

  itemAt(v: number): RowItem | null {
    return this.row.K ? this.row.item(v) : null;
  }
  idOf(v: number): string {
    const it = this.row.item(v);
    return it.kind === "book" ? it.essay.id : it.key;
  }
  nearestV(id: string): number | null {
    const k = this.row.kOfId(id);
    return k === undefined ? null : this.row.nearestV(k, this.pos);
  }
  nearestBookToCenter(): number | null {
    if (!this.row.K) return null;
    const v0 = this.row.vAt(this.pos);
    for (let d = 0; d < this.row.K; d++) {
      for (const v of [v0 + d, v0 - d]) {
        if (!this.row.looping && (v < 0 || v >= this.row.K)) continue;
        if (this.row.isBook(v)) return v;
      }
    }
    return null;
  }
  stepBook(v: number, dir: 1 | -1) {
    return this.row.stepBook(v, dir);
  }

  // ----------------------------------------------------------- positions

  private clampPos(p: number) {
    if (this.row.looping) return p;
    const half = this.drum.sMax * 0.95;
    if (this.row.length <= 2 * half) return this.row.length / 2;
    return Math.min(this.row.length - half, Math.max(half, p));
  }
  setPos(p: number) {
    this.pos = this.clampPos(p);
  }
  /** The row coordinate drawn at the stage centre (pos plus the fit pan). */
  get viewPos() {
    return this.pos + this.fit;
  }
  /** Item v's arc offset from parting and from the shelf closing up after a topic change. */
  slide(v: number) {
    return this.offsetOf(v) + this.morphOf(v);
  }
  private morphOf(v: number) {
    if (!this.morphFrom.size) return 0;
    const k = this.row.kOf(v);
    // (only the held copy slides; the others come in at their places once the row has closed up)
    const hv = this.heldV.get(k);
    if (hv !== undefined && hv !== v) return 0;
    return this.morphOfK(k);
  }
  /** A kept book's other copies settle in from just above once the row has closed up. */
  private copyDrop(v: number, s: number) {
    const hv = this.heldV.get(this.row.kOf(v));
    if (hv === undefined || hv === v) return 0;
    const delay = ENTRANCE_STAGGER_MS * Math.min(1, Math.abs(s) / this.drum.sMax);
    const t = (this.lastNow - this.morphEndAt - delay) / ENTRANCE_MS;
    if (t >= 1) return 0;
    const u = 1 - Math.max(0, t);
    return ENTRANCE_DROP * u * u * u;
  }
  private morphOfK(k: number) {
    const d = this.morphFrom.get(k);
    if (d === undefined) return 0;
    const t = (this.lastNow - this.morphAt - this.morphDelay) / this.morphDur;
    if (t <= 0) return d;
    if (t >= 1) return 0;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    return d * (1 - e);
  }
  /** The time of the frame being drawn. */
  get lastFrameTime() {
    return this.lastNow;
  }
  get morphing() {
    return this.morphFrom.size > 0;
  }
  /** A bookend's height scale while it grows in (1 = full). */
  markerScale(issue: number) {
    const at = this.enterMarkers.get(issue);
    if (at === undefined) return 1;
    const t = (this.lastNow - at - this.morphDelay) / 300;
    return t <= 0 ? 0.001 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
  }
  /** Shelf hover and clicks only when nothing is rearranging. */
  get shelfInteractive() {
    return !this.morphFrom.size;
  }
  get stageEl() {
    return this.stage;
  }

  /** World pose of item v at arc s: its box centre and orientation (Ry(rotY)·Rz(lean)). */
  private boxPose(v: number, s: number, turn: number | undefined, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, lift?: number) {
    const it = this.row.item(v);
    const P = this.poseOf(v, s, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 }, undefined, turn, lift);
    const c = Math.cos(P.rotY);
    const sn = Math.sin(P.rotY);
    const cl = Math.cos(P.lean);
    const sl = Math.sin(P.lean);
    const h = it.h;
    const D = it.kind === "book" ? BOOK_DEPTH : 40;
    // centre = P + R·(0, h/2, -D/2), R columns r1 = (-c·sl, cl, sn·sl), r2 = (sn, 0, c)
    p.x = P.x + -c * sl * (h / 2) - sn * (D / 2);
    p.y = P.y + cl * (h / 2);
    p.z = P.z + sn * sl * (h / 2) - c * (D / 2);
    const sy = Math.sin(P.rotY / 2);
    const cy = Math.cos(P.rotY / 2);
    const sz = Math.sin(P.lean / 2);
    const cz = Math.cos(P.lean / 2);
    q.x = sy * sz;
    q.y = sy * cz;
    q.z = cy * sz;
    q.w = cy * cz;
  }

  /** Where a book's shelf slot is right now (box centre + orientation), for a book flying back. */
  slotPose(id: string, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, nearX?: number, lift = 0): boolean {
    // (a looping row shows a slot more than once: a flight that chose a copy keeps it, by `nearX`)
    const k = this.row.kOfId(id);
    const v = k === undefined ? null : this.row.nearestV(k, nearX === undefined ? this.pos : nearX);
    if (v === null) return false;
    const s = this.row.centerOf(v) - this.viewPos + this.slide(v);
    this.boxPose(v, s, 0, p, q, lift);
    return true;
  }
  /** A returning book landed: draw it on the shelf again. */
  unhide(id: string) {
    if (this.hidden.delete(id)) {
      this.setTurnTargets();
      this.requestFrame();
    }
  }

  /**
   * A topic change. Swaps to `row` keeping the book nearest the centre where
   * it stands (when it stays), and slides every remaining book from where it
   * stood to its new place (after the fallers clear). `returning` books get
   * their slots now but are drawn by the ground until they land. Returns the
   * books that leave, with their poses if they're on screen.
   */
  morphTo(row: Row, returning: string[], reduced: boolean, keepHidden: string[] = []): LeaveInfo[] {
    const now = performance.now();
    const oldRow = this.row;
    const old = new Map<string, { s: number; v: number }>();
    this.forEachVisible((v, s) => old.set(this.idOf(v), { s, v }));
    const onScreen = this.drum.sMax + 60;
    const leaving: LeaveInfo[] = [];
    for (const it of oldRow.items) {
      if (it.kind !== "book" || row.kOfId(it.essay.id) !== undefined) continue;
      const o = old.get(it.essay.id);
      leaving.push({ id: it.essay.id, s: o && Math.abs(o.s) <= onScreen && !this.hidden.has(it.essay.id) ? o.s : null, x: o ? this.row.centerOf(o.v) : null });
    }
    // bookends: leaving ones shrink where they stood, new ones grow in
    this.leavingMarkers = [];
    this.enterMarkers.clear();
    if (!reduced) {
      for (const [key, o] of old) {
        const it = oldRow.item(o.v);
        if (it.kind === "marker" && row.kOfId(key) === undefined) this.leavingMarkers.push({ issue: it.issue, v: o.v, s: o.s, at: now });
      }
    }
    // the anchor: the remaining book nearest the centre stays put
    let anchor: { id: string; s: number } | null = null;
    for (const [id, o] of old) {
      if (!oldRow.isBook(o.v) || row.kOfId(id) === undefined || returning.includes(id)) continue;
      if (!anchor || Math.abs(o.s) < Math.abs(anchor.s)) anchor = { id, s: o.s };
    }
    this.setRow(row);
    if (anchor && row.looping) this.setPos(row.center[row.kOfId(anchor.id)!] - anchor.s);
    this.morphFrom.clear();
    this.heldV.clear();
    this.entering = [];
    if (!reduced) {
      for (const [id, o] of old) {
        const k = row.kOfId(id);
        if (k === undefined || returning.includes(id)) continue;
        const v = row.nearestV(k, this.pos + o.s);
        const d = o.s - (row.centerOf(v) - this.pos);
        if (Math.abs(d) > 0.5) this.morphFrom.set(k, d);
        if (row.looping) this.heldV.set(k, v);
      }
      // a book that was out of view and now has a slot in view is the ground's to bring in: it
      // rises into its slot once the row has closed up (it never appears standing in a slot
      // another book is still in, nor slides through one)
      for (const it of row.items) {
        if (it.kind !== "book" || old.has(it.essay.id) || returning.includes(it.essay.id)) continue;
        const k = row.kOfId(it.essay.id)!;
        const s = row.centerOf(row.nearestV(k, this.pos)) - this.pos;
        if (Math.abs(s) > onScreen) continue;
        this.entering.push(it.essay.id);
      }
      for (const it of row.items) if (it.kind === "marker" && !old.has(it.key)) this.enterMarkers.set(it.issue, now);
      this.morphAt = now;
      // with books falling in view the row closes up at ~0.9 s (once they have cleared the plank), in
      // ~650 ms; with books flying back the row holds its places until they are inbound (~550 ms)
      const falling = leaving.some((l) => l.s !== null);
      this.morphDelay = falling ? 900 : returning.length ? 550 : 230;
      this.morphDur = falling ? 650 : 720;
    }
    this.hidden = new Set([...returning, ...this.entering]);
    for (const id of keepHidden) if (row.kOfId(id) !== undefined) this.hidden.add(id);
    this.requestFrame();
    return leaving;
  }
  /** books the last morph left to the ground to bring in (new to the view): flown in like returners */
  entering: string[] = [];
  /** The ground draws this shelf book now (on the desk / in flight): its slot stays empty. */
  hide(id: string) {
    if (!this.hidden.has(id)) {
      this.hidden.add(id);
      // the slot neither turns nor parts while empty
      if (this.selected !== null && this.idOf(this.selected) === id) this.setTurnTargets();
      this.requestFrame();
    }
  }
  centerTarget(v: number) {
    return this.row.centerOf(v);
  }

  // --------------------------------------------------- turn + parting

  private turnedList(): number[] {
    // (a selected book has left the shelf for the desk: its empty slot neither turns nor parts)
    const out: number[] = [];
    if (this.selected !== null && !this.hidden.has(this.idOf(this.selected))) out.push(this.selected);
    return out;
  }
  /** Target offset of item v once the turned books are fully turned (the stable layout that hit-testing and the fit read). */
  private targetOffset(v: number, turned: number[]) {
    let off = 0;
    const R = this.view.w * 1.5 + 200;
    const cv = this.row.centerOf(v);
    for (const t of turned) {
      const ct = this.row.centerOf(t);
      if (Math.abs(cv - ct) > R) continue;
      const it = this.row.item(t);
      if (it.kind !== "book") continue;
      const extra = Math.max(0, it.fp.right - it.fp.left - it.w);
      if (v < t) off -= extra / 2;
      else if (v > t) off += extra / 2;
      else off += this.turnCentre(t);
    }
    return off;
  }
  /**
   * How much of a turned book's full slot a cover turned `w` of the way needs: the width its
   * box projects at that angle (its spine's share foreshortening as the cover's grows), as a
   * share of the extra the full turn needs; so the slot a cover is given follows the width it
   * actually shows, out and back, and never a tween of its own.
   */
  private slotShare(it: Extract<RowItem, { kind: "book" }>, w: number) {
    if (w <= 0) return 0;
    if (w >= 1) return 1;
    const coverW = it.fp.right - it.fp.left;
    const spine = it.w;
    const extra = coverW - spine;
    if (extra <= 0) return w;
    const a1 = Math.abs(TURN_RAD);
    const c1 = Math.abs(Math.cos(a1));
    const s1 = Math.abs(Math.sin(a1));
    // (the face's width such that the box projects the full slot at the full turn)
    const face = Math.max(0, (coverW - spine * c1) / Math.max(1e-6, s1));
    const a = a1 * w;
    const shown = spine * Math.abs(Math.cos(a)) + face * Math.abs(Math.sin(a));
    return Math.max(0, Math.min(1, (shown - spine) / extra));
  }
  /**
   * How far (row units) to shift a turned book so its projected cover sits
   * exactly at the stage centre when its slot is centred: measured from the 3D
   * pose (cached per item; cleared on resize and on a new row).
   */
  private turnCentres = new Map<number, number>();
  private turnCentre(v: number) {
    const k = this.row.kOf(v);
    const hit = this.turnCentres.get(k);
    if (hit !== undefined) return hit;
    const it = this.row.items[k];
    let o = it.kind === "book" ? it.w / 2 - (it.fp.left + it.fp.right) / 2 : 0;
    if (this.view.w > 0 && it.kind === "book") {
      for (let i = 0; i < 3; i++) {
        const r = this.rectOf(v, { s: o, turn: 1 });
        if (!r) break;
        const off = r.left + r.width / 2 - this.view.halfW;
        if (Math.abs(off) < 0.25) break;
        o -= off / this.view.k;
      }
    }
    this.turnCentres.set(k, o);
    return o;
  }
  /**
   * Item v's parting offset right now: every book turned, turning out or turning back
   * keeps the slot its cover shows this frame (its neighbours parted by half of that each
   * side, the book itself centred in it), so two covers never share a slot, a cover turning
   * back gives its room up as it closes, and nothing is ever shoved over a neighbour that
   * has not parted.
   */
  offsetOf(v: number) {
    if (!this.turnT.size) return 0;
    let off = 0;
    const R = this.view.w * 1.5 + 200;
    const cv = this.row.centerOf(v);
    for (const p of this.partingNow()) {
      if (Math.abs(cv - p.c) > R) continue;
      if (v < p.t) off -= p.left;
      else if (v > p.t) off += p.right;
      else off += p.shift;
    }
    return off;
  }
  /** what the turned books' boxes need this frame (rebuilt when a tween moves or the turned set changes) */
  private partCache: { t: number; c: number; left: number; right: number; shift: number }[] = [];
  private partDirty = true;
  /**
   * Each turned, turning-out or turning-back book this frame: its shift along the shelf
   * (centred in its slot as it turns) and how far its projected box reaches beyond its
   * closed spine's slot on each side, with the parting margin: measured on the box the
   * frame will draw (the lift and the pull included), so what the neighbours make room
   * for is exactly what shows, however far the turn has got.
   */
  private partingNow() {
    if (!this.partDirty) return this.partCache;
    this.partDirty = false;
    const out: typeof this.partCache = [];
    const k = this.view.k || 1;
    for (const [t, tw] of this.turnT) {
      const w = tw.from + (tw.to - tw.from) * easeOutExpo(tw.p);
      if (w <= 0.0005) continue;
      const it = this.row.item(t);
      if (it.kind !== "book") continue;
      const c = this.row.centerOf(t);
      const share = this.slotShare(it, w);
      const shift = this.turnCentre(t) * share;
      const extra = Math.max(0, it.fp.right - it.fp.left - it.w);
      // (the full margin from the first frame of a turn: the near-shut cover's corner is the closest a book comes to its neighbour)
      const m = PART_MARGIN + 2;
      let left = (extra / 2) * share;
      let right = left;
      const s = c - this.viewPos + shift;
      if (this.view.w > 0 && Math.abs(s) <= this.drum.sLim) {
        const rT = this.rectOf(t, { s, turn: w });
        if (rT) {
          // (against the closed spine's face, not its whole box: on the curved shelf a box's
          // sides project beyond its face, hidden by its neighbours)
          const p0 = this.poseOf(t, c - this.viewPos, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 }, undefined, 0);
          const c0 = Math.cos(p0.rotY);
          const s0 = Math.sin(p0.rotY);
          let f0l = Infinity;
          let f0r = -Infinity;
          const pt = { x: 0, y: 0 };
          for (const lx of [-it.w / 2, it.w / 2])
            for (const ly of [0, it.h]) {
              this.project(p0.x + lx * c0, p0.y + ly, p0.z - lx * s0, pt);
              f0l = Math.min(f0l, pt.x);
              f0r = Math.max(f0r, pt.x);
            }
          left = Math.max(0, f0l - rT.left) / k + m;
          right = Math.max(0, rT.left + rT.width - f0r) / k + m;
        }
      }
      out.push({ t, c, left, right, shift });
    }
    this.partCache = out;
    return out;
  }
  /** Eased turn amount of v (0 resting .. 1 turned). */
  turnOf(v: number) {
    const t = this.turnT.get(v);
    return t === undefined ? 0 : t.from + (t.to - t.from) * easeOutExpo(t.p);
  }
  /**
   * The turn tweens follow the turned set: a book newly turned starts turning out (from
   * wherever it is), one no longer turned starts turning back the same frame (faster than
   * it opened), from wherever it is; so exactly one book opens at a time and every other
   * one that was mid-turn closes, however fast the pointer sweeps.
   */
  private setTurnTargets() {
    this.partDirty = true;
    const turned = new Set(this.turnedList());
    for (const v of turned) {
      const cur = this.turnT.get(v);
      if (!cur) this.turnT.set(v, { from: 0, to: 1, p: this.reduced ? 1 : 0, dur: TURN.ms });
      else if (cur.to !== 1) this.turnT.set(v, { from: this.turnOf(v), to: 1, p: this.reduced ? 1 : 0, dur: TURN.ms });
    }
    for (const [v, t] of this.turnT) {
      if (turned.has(v) || t.to === 0) continue;
      if (this.reduced) this.turnT.delete(v);
      else this.turnT.set(v, { from: this.turnOf(v), to: 0, p: 0, dur: CLOSE_MS });
    }
  }
  /** Items currently turned or turning back (their covers show). */
  turningNow(): IterableIterator<number> {
    return this.turnT.keys();
  }
  isTurnedTarget(v: number) {
    // (a selected book that has left for the desk neither turns nor widens its slot)
    return v === this.selected && !this.hidden.has(this.idOf(v));
  }

  // ------------------------------------------------------------ hover lift

  /** Eased lift of v (0 resting .. 1 lifted and slid out of the row): the hover, the keyboard highlight, a first tap. */
  liftOf(v: number) {
    const t = this.liftT.get(v);
    return t === undefined ? 0 : t.from + (t.to - t.from) * (t.to ? easeOutExpo(t.p) : easeOutCubic(t.p));
  }
  private isLiftTarget(v: number) {
    return v === this.hovered && this.row.isBook(v) && !this.hidden.has(this.idOf(v));
  }
  /**
   * The lift tweens follow the hovered book: it starts lifting (from wherever it is), every
   * other one starts settling back the same frame (quicker), from wherever it is.
   */
  private setLiftTargets() {
    for (const [v, t] of this.liftT) {
      if (this.isLiftTarget(v) || t.to === 0) continue;
      if (this.reduced) this.liftT.delete(v);
      else this.liftT.set(v, { from: this.liftOf(v), to: 0, p: 0, dur: HOVER_BACK_MS });
    }
    const v = this.hovered;
    if (v !== null && this.isLiftTarget(v)) {
      const cur = this.liftT.get(v);
      if (!cur) this.liftT.set(v, { from: 0, to: 1, p: this.reduced ? 1 : 0, dur: HOVER_MS });
      else if (cur.to !== 1) this.liftT.set(v, { from: this.liftOf(v), to: 1, p: this.reduced ? 1 : 0, dur: HOVER_MS });
    }
  }

  setHover(v: number | null, source: HoverSource | null) {
    if (v === this.hovered && (v === null || source === this.hoverSource)) return;
    this.hovered = v;
    this.hoverSource = v === null ? null : source;
    this.setLiftTargets();
    this.emitHover();
    this.requestFrame();
  }
  select(v: number | null) {
    if (v === this.selected) return;
    this.selected = v;
    this.setTurnTargets();
    this.requestFrame();
  }

  // --------------------------------------------------------- projection

  /** Pose of item v at arc position s (shared by the scene and hit areas). */
  poseOf(v: number, s: number, out: Pose, tmp = { x: 0, z: 0, phi: 0 }, turn?: number, lift?: number): Pose {
    const it = this.row.item(v);
    this.drum.at(s, tmp);
    const p = it.kind === "book" ? (turn ?? this.turnOf(v)) : 0;
    const l = it.kind === "book" ? (lift ?? this.liftOf(v)) : 0;
    const depth = it.kind === "book" ? it.essay.depth : 0;
    const lean = it.kind === "book" ? it.essay.lean : 0;
    const nx = Math.sin(tmp.phi);
    const nz = Math.cos(tmp.phi);
    // (the hover: up a little and out of the row along the shelf's normal, no turn)
    const slide = HOVER_SLIDE * l;
    out.x = tmp.x + nx * (depth + slide);
    out.z = tmp.z + nz * (depth + slide) + TURN.pull * p;
    out.y = -TURN.lift * p + (HOVER_LIFT_PX / (this.view.k || 1)) * l;
    out.rotY = tmp.phi + (TURN_RAD - tmp.phi) * p;
    out.lean = (-(lean * Math.PI) / 180) * (1 - p);
    out.turn = p;
    if (this.entranceAt) out.y += this.entranceDrop(s);
    if (this.heldV.size) out.y += this.copyDrop(v, s);
    return out;
  }

  /** The shelf's first appearance (skipped under reduced motion). */
  startEntrance() {
    if (this.reduced) return;
    this.entranceAt = performance.now();
    this.requestFrame();
  }
  private entranceDrop(s: number) {
    const delay = ENTRANCE_STAGGER_MS * Math.min(1, Math.abs(s) / this.drum.sMax);
    const t = (this.lastNow - this.entranceAt - delay) / ENTRANCE_MS;
    if (t >= 1) return 0;
    const u = Math.max(0, t);
    return ENTRANCE_DROP * (1 - u) * (1 - u) * (1 - u);
  }
  /** Stage position of a book's spine centre (or a bookend's face), at its current pose. */
  spineCenterOf(v: number): { x: number; y: number } | null {
    const it = this.row.item(v);
    const s = this.row.centerOf(v) - this.viewPos + this.slide(v);
    if (Math.abs(s) > this.drum.sLim) return null;
    const pose = this.poseOf(v, s, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 });
    return this.project(pose.x, pose.y + it.h / 2, pose.z, { x: 0, y: 0 });
  }
  /** World point -> stage pixel. */
  project(x: number, y: number, z: number, out: { x: number; y: number }) {
    const k = (this.view.k * this.view.d) / (this.view.d - z);
    out.x = this.view.halfW + x * k;
    out.y = this.view.horizonY + (this.view.E - y) * k;
    return out;
  }
  /** Stage pixel -> world point on the plane at depth z (the inverse of project). */
  unproject(px: number, py: number, z: number, out: { x: number; y: number; z: number }) {
    const k = (this.view.k * this.view.d) / (this.view.d - z);
    out.x = (px - this.view.halfW) / k;
    out.y = this.view.E - (py - this.view.horizonY) / k;
    out.z = z;
    return out;
  }
  /** The depth at which `units` world units project to `px` stage pixels (a desk-sized book). */
  depthForScale(px: number, units: number) {
    const want = px / units;
    return this.view.d * (1 - this.view.k / want);
  }
  /** Screen rect of a book/bookend's box at its current pose (stage px). */
  rectOf(v: number, at?: { s: number; turn: number }): ScreenRect | null {
    const it = this.row.item(v);
    const s = at ? at.s : this.row.centerOf(v) - this.viewPos + this.slide(v);
    if (Math.abs(s) > this.drum.sLim) return null;
    const pose = this.poseOf(v, s, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 }, undefined, at?.turn);
    const c = Math.cos(pose.rotY);
    const sn = Math.sin(pose.rotY);
    const D = it.kind === "book" ? BOOK_DEPTH : 40;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const pt = { x: 0, y: 0 };
    for (const lx of [-it.w / 2, it.w / 2])
      for (const lz of [0, -D])
        for (const ly of [0, it.h]) {
          const wx = pose.x + lx * c + lz * sn;
          const wz = pose.z - lx * sn + lz * c;
          this.project(wx, pose.y + ly, wz, pt);
          minX = Math.min(minX, pt.x);
          maxX = Math.max(maxX, pt.x);
          minY = Math.min(minY, pt.y);
          maxY = Math.max(maxY, pt.y);
        }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  /** The projected bottom-front edge of a book's box (stage px): the slot it stands in. */
  frontEdgeOf(v: number): { x0: number; x1: number; y: number } | null {
    const it = this.row.item(v);
    const s = this.row.centerOf(v) - this.viewPos + this.slide(v);
    if (Math.abs(s) > this.drum.sLim) return null;
    const pose = this.poseOf(v, s, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 });
    const c = Math.cos(pose.rotY);
    const sn = Math.sin(pose.rotY);
    const a = this.project(pose.x - (it.w / 2) * c, pose.y, pose.z + (it.w / 2) * sn, { x: 0, y: 0 });
    const b = this.project(pose.x + (it.w / 2) * c, pose.y, pose.z - (it.w / 2) * sn, { x: 0, y: 0 });
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y: (a.y + b.y) / 2 };
  }

  /** Visit every item near the view with its arc position. */
  forEachVisible(cb: (v: number, s: number) => void) {
    if (!this.row.K) return;
    const lim = this.drum.sLim;
    const vp = this.viewPos;
    if (!this.row.looping) {
      for (let v = 0; v < this.row.K; v++) {
        const s = this.row.centerOf(v) - vp + this.slide(v);
        if (Math.abs(s) <= lim) cb(v, s);
      }
      return;
    }
    const [a, b] = this.row.vRange(vp - lim - 200, vp + lim + 200);
    // (while the row closes up, a held book shows once: its other copies come in afterwards)
    const holding = this.heldV.size > 0 && this.lastNow < this.morphEndAt;
    for (let v = a; v <= b; v++) {
      if (holding) {
        const hv = this.heldV.get(this.row.kOf(v));
        if (hv !== undefined && hv !== v) continue;
      }
      const s = this.row.centerOf(v) - vp + this.slide(v);
      if (Math.abs(s) <= lim) cb(v, s);
    }
    // a book held where it stood while the row changes under it may be far from its new slot:
    // the held copy is visited too
    if (this.morphFrom.size)
      for (const [k, hv] of this.heldV) {
        if ((hv >= a && hv <= b) || !this.morphOfK(k)) continue;
        const s = this.row.centerOf(hv) - vp + this.slide(hv);
        if (Math.abs(s) <= lim) cb(hv, s);
      }
  }

  // ------------------------------------------------------------- hit-test

  /** Which item is under stage x, from the stable target layout (by column). */
  hitTest(stageX: number): number | null {
    if (!this.row.K || !this.view.w) return null;
    const s = this.drum.sAtScreen((stageX - this.view.halfW) / this.view.k);
    const r = this.pos + this.fitTo + s;
    const turned = this.turnedList();
    for (const t of turned) {
      const it = this.row.item(t);
      if (it.kind !== "book") continue;
      const o = this.targetOffset(t, turned);
      const l = this.row.leftOf(t) + o;
      if (r >= l + it.fp.left && r <= l + it.fp.right) return t;
    }
    const v0 = this.row.vAt(r);
    let best: number | null = null;
    let bestD = Infinity;
    for (let v = v0 - 14; v <= v0 + 14; v++) {
      if (!this.row.looping && (v < 0 || v >= this.row.K)) continue;
      const it = this.row.item(v);
      const o = this.targetOffset(v, turned);
      let a: number;
      let b: number;
      if (it.kind === "book" && turned.includes(v)) {
        const l = this.row.leftOf(v) + o;
        a = l + it.fp.left;
        b = l + it.fp.right;
      } else {
        a = this.row.leftOf(v) + o;
        b = a + it.w;
      }
      const d = r < a ? a - r : r > b ? r - b : 0;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return bestD > 40 ? null : best;
  }

  /** Is stage y within the item's own height (plus the page tops)? */
  private isOnItem(v: number, stageY: number) {
    const it = this.row.item(v);
    const s = this.row.centerOf(v) - this.viewPos + this.slide(v);
    const pose = this.poseOf(v, s, { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 });
    const pt = { x: 0, y: 0 };
    this.project(pose.x, pose.y + it.h, pose.z, pt);
    const top = pt.y - CLICK_TOP_TOLERANCE;
    this.project(pose.x, pose.y, pose.z, pt);
    return stageY >= top && stageY <= pt.y + 10;
  }

  private stageXY(e: { clientX: number; clientY: number }) {
    const r = this.stage!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private rehover() {
    if (!this.pointerInside || this.dragging || this.glide || this.lastPointerType === "touch" || !this.stage) return;
    const r = this.stage.getBoundingClientRect();
    if (!this.shelfInteractive || this.lastClientY - r.top > this.view.frameH) {
      this.scheduleLeave();
      return;
    }
    const v = this.hitTest(this.lastClientX - r.left);
    if (v === null) this.scheduleLeave();
    else {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = 0;
      this.setHover(v, "pointer");
    }
  }
  private scheduleLeave() {
    if (this.leaveTimer || this.hoverSource !== "pointer") return;
    this.leaveTimer = window.setTimeout(() => {
      this.leaveTimer = 0;
      if (this.hoverSource === "pointer") this.setHover(null, null);
    }, LEAVE_GRACE_MS);
  }

  // ---------------------------------------------------------- hover store

  subscribeHover = (fn: () => void) => {
    this.hoverListeners.add(fn);
    return () => this.hoverListeners.delete(fn);
  };
  getHoverSnapshot = () => this.hoverSnap;
  private emitHover() {
    if (this.hoverSnap.gi === this.hovered && this.hoverSnap.source === this.hoverSource) return;
    this.hoverSnap = { gi: this.hovered, source: this.hoverSource };
    this.hoverListeners.forEach((l) => l());
  }

  // --------------------------------------------------- drift and motion

  setUserPaused(p: boolean) {
    this.userPaused = p;
    this.requestFrame();
  }
  setReduced(r: boolean) {
    this.reduced = r;
    if (r) {
      this.stopMotion();
      for (const t of this.turnT.values()) t.p = 1;
      for (const t of this.liftT.values()) t.p = 1;
    }
  }
  setPanelOpen(open: boolean) {
    this.panelOpen = open;
    if (!open) this.markInteraction();
    this.requestFrame();
  }
  markInteraction(ms = RESUME_AFTER_MS) {
    this.interactionUntil = Math.max(this.interactionUntil, performance.now() + ms);
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => this.requestFrame(), this.interactionUntil - performance.now() + 20);
  }
  get driftEnabled() {
    return this.row.looping && !this.userPaused && !this.reduced;
  }
  /** Is the shelf drifting right now (debug / tests)? */
  get drifting() {
    return this.canDrift(performance.now()) && this.glide === null;
  }
  private canDrift(now: number) {
    return (
      this.driftEnabled &&
      !this.pointerInside &&
      !this.panelOpen &&
      !this.dragging &&
      this.hovered === null &&
      // (a book still settling back holds the drift: it lands where it is, never carried off)
      this.liftT.size === 0 &&
      this.turnT.size === 0 &&
      now >= this.interactionUntil &&
      document.visibilityState === "visible"
    );
  }
  get isGliding() {
    return this.glide !== null;
  }
  stopMotion() {
    this.glide = null;
    this.flingV = 0;
    this.wheelTarget = null;
  }

  /**
   * Advance everything by real elapsed time. Returns true while anything is
   * still moving (the canvas keeps rendering), false when idle.
   */
  frame(now: number): boolean {
    let dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;
    // (a stall, a tab switch: at most 50 ms of motion is carried over, never a jump; the
    // ground's clock does the same)
    if (dt < 0) dt = 0;
    if (dt > 0.05) dt = 0.05;
    let active = false;
    const pos0 = this.pos;
    if (this.morphFrom.size || this.leavingMarkers.length || this.enterMarkers.size) {
      const end = this.morphAt + this.morphDelay + Math.max(this.morphDur, 300);
      if (now > end) {
        this.morphFrom.clear();
        this.enterMarkers.clear();
      } else active = true;
      this.leavingMarkers = this.leavingMarkers.filter((m) => now - m.at < 260);
      if (this.leavingMarkers.length) active = true;
    }
    if (this.entranceAt) {
      if (now - this.entranceAt > ENTRANCE_MS + ENTRANCE_STAGGER_MS) this.entranceAt = 0;
      else active = true;
    }
    if (this.heldV.size) {
      if (now > this.morphEndAt + ENTRANCE_MS + ENTRANCE_STAGGER_MS) this.heldV.clear();
      else active = true;
    }

    // turn tweens (the targets re-read every frame: a book hidden for the desk closes too)
    if (this.turnT.size) this.partDirty = true;
    for (const [v, t] of this.turnT) {
      const target = this.isTurnedTarget(v) ? 1 : 0;
      if (t.to !== target) {
        const from = this.turnOf(v);
        t.from = from;
        t.to = target;
        t.p = this.reduced ? 1 : 0;
        t.dur = target ? TURN.ms : CLOSE_MS;
      }
      if (t.p < 1) {
        t.p = Math.min(1, t.p + dt / (t.dur / 1000));
        active = true;
      }
      if (t.p >= 1 && t.to === 0) this.turnT.delete(v);
    }
    // lift tweens (a book hidden for the desk settles too, unseen)
    for (const [v, t] of this.liftT) {
      const target = this.isLiftTarget(v) ? 1 : 0;
      if (t.to !== target) {
        t.from = this.liftOf(v);
        t.to = target;
        t.p = this.reduced ? 1 : 0;
        t.dur = target ? HOVER_MS : HOVER_BACK_MS;
      }
      if (t.p < 1) {
        t.p = Math.min(1, t.p + dt / (t.dur / 1000));
        active = true;
      }
      if (t.p >= 1 && t.to === 0) this.liftT.delete(v);
    }

    // motion
    const g = this.glide;
    if (g) {
      g.t += dt;
      this.setPos(g.from + g.at(Math.min(g.t, g.dur)));
      if (g.t >= g.dur) {
        this.glide = null;
        g.done?.();
        this.rehover();
      } else active = true;
    } else if (this.flingV !== 0) {
      this.setPos(this.pos + this.flingV * dt);
      this.flingV *= Math.exp(-dt / FLING_TAU);
      if (Math.abs(this.flingV) < 12) this.flingV = 0;
      else active = true;
      this.markInteraction();
    } else if (this.wheelTarget !== null) {
      const k = 1 - Math.exp(-dt / WHEEL_TAU);
      this.setPos(this.pos + (this.wheelTarget - this.pos) * k);
      if (Math.abs(this.wheelTarget - this.pos) < 0.05) {
        this.setPos(this.wheelTarget);
        this.wheelTarget = null;
      } else active = true;
    } else if (this.canDrift(performance.now())) {
      this.setPos(this.pos + (DRIFT_PX_PER_S / this.view.k) * dt);
      active = true;
    }
    if (this.dragging) active = true;

    if (dt > 0) this.speed += (Math.abs(this.pos - pos0) / dt - this.speed) * Math.min(1, dt / 0.08);

    // the fit pan: keep turned covers inside the stage
    this.fitTo = this.computeFit();
    if (this.fit !== this.fitTo) {
      const kf = this.reduced ? 1 : dt ? 1 - Math.exp(-dt / FIT_TAU) : 0;
      this.fit += (this.fitTo - this.fit) * kf;
      if (Math.abs(this.fitTo - this.fit) < 0.05) this.fit = this.fitTo;
      else active = true;
    }
    this.updateFocusRing();
    return active;
  }

  /**
   * How far (row units) to pan so every turned book's cover, at its full turn
   * and target parting, sits inside the stage. Judged at the glide's
   * destination while gliding, so it never fights a glide.
   */
  private computeFit(): number {
    const turned = this.turnedList();
    if (!turned.length || !this.view.w) return 0;
    const ref = this.glide ? this.glide.to : this.pos;
    const w = this.view.w;
    const margin = FIT_MARGIN + w * SIDE_FADE;
    let fit = 0;
    for (let iter = 0; iter < 3; iter++) {
      let over = 0;
      for (const t of turned) {
        if (!this.row.isBook(t)) continue;
        const s = this.row.centerOf(t) - (ref + fit) + this.targetOffset(t, turned);
        if (Math.abs(s) > this.drum.sLim) continue;
        const r = this.rectOf(t, { s, turn: 1 });
        if (!r) continue;
        const right = r.left + r.width - (w - margin);
        const left = margin - r.left;
        if (right > 0 && right > Math.abs(over)) over = right;
        else if (left > 0 && left > Math.abs(over)) over = -left;
      }
      if (Math.abs(over) < 0.5) break;
      fit += over / this.view.k;
    }
    return fit;
  }

  glideTo(target: number, dur: number, done?: () => void, ease: (t: number) => number = easeOutCubic) {
    this.flingV = 0;
    this.wheelTarget = null;
    if (this.reduced || dur <= 0) {
      this.glide = null;
      this.setPos(target);
      done?.();
      this.rehover();
      this.requestFrame();
      return;
    }
    const from = this.pos;
    const D = target - from;
    this.glide = { from, to: target, t: 0, dur: dur / 1000, at: (t) => D * ease(t / (dur / 1000)), done };
    this.requestFrame();
  }
  glideToCenter(v: number, dur: number, done?: () => void) {
    this.glideTo(this.centerTarget(v), dur, done);
  }
  centerOn(v: number) {
    this.stopMotion();
    this.setPos(this.centerTarget(v));
    this.requestFrame();
  }

  /** Distances (row units) at which essay k can land centred. */
  private landings(k: number): number[] {
    const out: number[] = [];
    const base = this.row.center[k] - this.pos; // distance to copy 0
    const c0 = Math.round(-base / this.row.S); // the nearest copy
    for (let m = -4; m <= 4; m++) out.push(base + (c0 + m) * this.row.S);
    return out;
  }
  spinReachable(id: string): boolean {
    const k = this.row.kOfId(id);
    if (k === undefined || !this.row.looping) return false;
    // the spin covers 2000–3500 SCREEN px
    const kk = this.view.k;
    return this.landings(k).some((d) => Math.abs(d) * kk >= 2000 && Math.abs(d) * kk <= 3500);
  }
  /** "Surprise me": the carousel spin, then done(v) with the landed copy. */
  spinTo(id: string, done: (v: number) => void) {
    const k = this.row.kOfId(id);
    if (k === undefined) return;
    if (!this.row.looping) {
      this.glideTo(this.row.center[k], 900, () => done(k));
      return;
    }
    let best = 0;
    let score = Infinity;
    for (const d of this.landings(k)) {
      const a = Math.abs(d) * this.view.k; // screen px
      const sc = a < 2000 ? 1e9 + (2000 - a) : a <= 3500 ? Math.abs(a - 2750) * 0.001 - (d > 0 ? 0.5 : 0) : a - 3500;
      if (sc < score) {
        score = sc;
        best = d;
      }
    }
    const target = this.pos + best;
    const v = this.row.nearestV(k, target);
    this.setHover(null, null);
    if (this.reduced) {
      this.setPos(target);
      done(v);
      this.requestFrame();
      return;
    }
    const curve = spinCurve(best, 2400 / this.view.k); // peak 2400 screen px/s
    this.flingV = 0;
    this.wheelTarget = null;
    this.glide = { from: this.pos, to: target, t: 0, dur: curve.dur, at: curve.at, done: () => done(v) };
    this.requestFrame();
  }

  // ------------------------------------------------------- keyboard / a11y

  /** Focus arrived on the shelf from outside: highlight the book at the centre. */
  kbdEnter(): string | null {
    const v = this.hoverSource === "kbd" && this.hovered !== null ? this.hovered : this.nearestBookToCenter();
    if (v === null) return null;
    this.markInteraction();
    this.setHover(v, "kbd");
    return this.idOf(v);
  }
  /** Focus moved to a specific book's button (screen reader / programmatic). */
  kbdFocus(id: string) {
    const v = this.nearestV(id);
    if (v === null) return;
    if (this.hovered === v && this.hoverSource === "kbd") return;
    this.markInteraction();
    this.setHover(v, "kbd");
    this.glideToCenter(v, 450);
  }
  /** ←/→: move the highlight one book and glide it into view. Returns its id. */
  kbdStep(dir: 1 | -1): string | null {
    const from =
      this.hoverSource === "kbd" && this.hovered !== null ? this.stepBook(this.hovered, dir) : this.nearestBookToCenter();
    if (from === null) return null;
    this.markInteraction();
    this.setHover(from, "kbd");
    this.glideToCenter(from, 450);
    return this.idOf(from);
  }
  kbdLeave() {
    if (this.hoverSource === "kbd") this.setHover(null, null);
  }
  /** Keep the keyboard ring on the highlighted book (one DOM element). */
  private ringKey = "";
  private updateFocusRing() {
    const ring = this.focusRing;
    if (!ring) return;
    const v = this.hoverSource === "kbd" ? this.hovered : null;
    const r = v !== null ? this.rectOf(v) : null;
    const key = r ? `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}` : "";
    if (key === this.ringKey) return;
    this.ringKey = key;
    if (!r) {
      ring.style.opacity = "0";
      return;
    }
    ring.style.opacity = "1";
    ring.style.width = `${r.width + 12}px`;
    ring.style.height = `${r.height + 12}px`;
    ring.style.transform = `translate3d(${r.left - 6}px, ${r.top - 6}px, 0)`;
  }

  // ---------------------------------------------------------------- events

  private onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.pointerInside = true;
  };
  private onPointerMove = (e: PointerEvent) => {
    this.lastPointerType = e.pointerType;
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      if (!d.moved && d.type === "touch") {
        // a touch that sets off vertically is the page's scroll (touch-action: pan-y); the shelf
        // takes only a horizontal swipe, and decides before moving anything
        const dy = e.clientY - d.y;
        if (Math.abs(dy) > DRAG_THRESHOLD && Math.abs(dy) >= Math.abs(dx)) {
          this.drag = null;
          return;
        }
      }
      if (!d.moved && Math.abs(dx) > DRAG_THRESHOLD) {
        d.moved = true;
        this.dragging = true;
        this.stopMotion();
        this.setHover(null, null);
        try {
          this.stage?.setPointerCapture(d.id);
        } catch {
          /* gone */
        }
      }
      if (d.moved) {
        this.markInteraction();
        this.setPos(d.pos - dx / this.view.k);
        const now = performance.now();
        d.samples.push([now, e.clientX]);
        while (d.samples.length > 2 && now - d.samples[0][0] > 100) d.samples.shift();
        this.requestFrame();
      }
      return;
    }
    if (e.pointerType === "touch") return;
    this.pointerInside = true;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    if (this.glide) return;
    this.rehover();
  };
  private onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.pointerInside = false;
    this.markInteraction(RESUME_AFTER_LEAVE_MS);
    this.scheduleLeave();
  };
  private onPointerDown = (e: PointerEvent) => {
    this.lastPointerType = e.pointerType;
    this.suppressClick = false;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("button, a, input")) return;
    // (a drag belongs to the shelf only from the shelf band; elsewhere the page scrolls)
    if (this.stage && !this.inShelfBand(e.clientY - this.stage.getBoundingClientRect().top)) return;
    if (e.pointerType === "mouse") {
      // no focus / text selection from shelf presses; like any click, they
      // still take focus away from a field elsewhere on the page
      e.preventDefault();
      const a = document.activeElement;
      if (a instanceof HTMLElement && a !== document.body && !this.stage?.contains(a)) a.blur();
    }
    this.markInteraction();
    this.drag = { x: e.clientX, y: e.clientY, pos: this.pos, moved: false, id: e.pointerId, type: e.pointerType, samples: [[performance.now(), e.clientX]] };
  };
  private endDrag(withClick: boolean) {
    const d = this.drag;
    this.drag = null;
    if (!d?.moved) return;
    this.dragging = false;
    if (withClick) this.suppressClick = true;
    try {
      this.stage?.releasePointerCapture(d.id);
    } catch {
      /* not captured */
    }
    // momentum from the last ~100ms of movement
    const s = d.samples;
    if (s.length >= 2 && !this.reduced) {
      const [t0, x0] = s[0];
      const [t1, x1] = s[s.length - 1];
      const dtm = (t1 - t0) / 1000;
      if (dtm > 0.008 && performance.now() - t1 < 80) {
        const v = -(x1 - x0) / dtm / this.view.k;
        const cap = 4000 / this.view.k;
        this.flingV = Math.max(-cap, Math.min(cap, v));
      }
    }
    this.markInteraction();
    this.requestFrame();
    this.rehover();
  }
  private onPointerUp = () => this.endDrag(true);
  private onPointerCancel = () => this.endDrag(false);

  private onClick = (e: MouseEvent) => {
    if (this.suppressClick) {
      this.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!this.stage || !this.shelfInteractive) return;
    const { x, y } = this.stageXY(e);
    if (y > this.view.frameH) return;
    const v = this.hitTest(x);
    // hover is by column, but a click in the empty band above a short book doesn't open it
    if (v === null || !this.isOnItem(v, y)) return;
    if (this.lastPointerType === "touch") {
      this.markInteraction();
      if (this.hovered === v || !this.row.isBook(v)) this.activate(v);
      else this.setHover(v, "touch");
      return;
    }
    this.activate(v);
  };

  activate(v: number) {
    const it = this.row.item(v);
    if (it.kind === "marker") {
      this.markInteraction();
      this.glideToCenter(this.stepBook(v, 1), 800);
      return;
    }
    this.onActivate(v);
  }

  /**
   * The shelf band in stage px: from just above the tallest book (room for the hover lift)
   * to the plank's bottom edge, the full width. Wheel and drags belong to the shelf only
   * there; everywhere else on the stage (the caption row, the desk, the
   * empty canvas above the books) the page scrolls as it normally would.
   */
  shelfBand(): { top: number; bottom: number } {
    const pt = { x: 0, y: 0 };
    const top = this.project(0, MAX_BOOK_H, 0, pt).y - HOVER_LIFT_PX - 6;
    const bottom = this.project(0, -LIP - 4, PLANK_FRONT, pt).y;
    return { top, bottom };
  }
  inShelfBand(stageY: number) {
    if (!this.view.w) return false;
    const b = this.shelfBand();
    return stageY >= b.top && stageY <= b.bottom;
  }

  /** Every wheel on the page passes here first (capture, passive: it never holds up a page scroll). */
  private onAnyWheel = (e: WheelEvent) => {
    this.wheelPrevAt = this.wheelAt;
    this.wheelPrevOwned = this.wheelOwned;
    this.wheelAt = e.timeStamp;
    this.wheelOwned = false;
  };
  private onWheel = (e: WheelEvent) => {
    // (only over the shelf band does the wheel move the shelf; elsewhere it is the page's)
    if (!this.stage || !this.inShelfBand(e.clientY - this.stage.getBoundingClientRect().top)) return;
    // a wheel the browser has already turned into a page scroll (dispatched after the fact, not
    // cancelable) is the page's even though the band has scrolled under the pointer meanwhile;
    // so is the continuation of a sequence that started scrolling the page
    if (!e.cancelable) return;
    if (e.timeStamp - this.wheelPrevAt < WHEEL_LATCH_MS && !this.wheelPrevOwned) return;
    if (!this.row.looping && this.row.length <= this.drum.sMax * 1.9) return;
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!dx) return;
    e.preventDefault();
    this.wheelOwned = true;
    const unit = (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? this.view.w : 1) / this.view.k;
    this.glide = null;
    this.flingV = 0;
    this.markInteraction();
    const base = this.wheelTarget ?? this.pos;
    this.wheelTarget = this.clampPos(base + dx * unit);
    if (this.reduced) {
      this.setPos(this.wheelTarget);
      this.wheelTarget = null;
    }
    this.requestFrame();
    if (this.hoverSource === "touch") this.setHover(null, null);
  };

  private onVisibility = () => {
    this.lastNow = 0;
    this.requestFrame();
  };
}
