import * as THREE from "three";
import type { Essay } from "../data/essays";
import { type DeskRect, type GroundHook, type LeaveInfo, type ShelfEngine3D } from "./engine";
import type { FloorSpec, HingeSpec, PartSpec } from "./physics";
import type { SimChunk, SimJob, SimResult } from "./simWorker";
import { BOOK_DEPTH, LIP, PLANK_FRONT, Row } from "./row";

/**
 * The books off the shelf (and the one on the desk), seen from the same eye-level view. A
 * topic pill makes the books outside the topic tip off the front of the plank and tumble
 * down out of the stage: the ones in view are hinged bodies (a base of back cover + pages, a
 * page group and the front cover on sprung revolute joints) whose fall is SIMULATED AT ONCE
 * in a worker (Rapier, 100 Hz) and PLAYED BACK with interpolation, smooth and the same on
 * every device; a book is gone the moment it has passed the stage's bottom edge. Nothing
 * lands, nothing lies anywhere: there is no floor. Choosing a book's topic again brings it up
 * from below the stage, as if from the ground, in an arc into its slot. The desk's book pulls
 * out of its slot, arcs down onto the desk, and flies back the same way.
 *
 * Simulation and poses live in SHELF-ROW space (x along the shelf, z toward the viewer,
 * flat); `toWorld` maps that onto the drum for rendering. Units are mm-ish.
 *
 * Every book has exactly one state, so rapid pill clicks just retarget:
 *   wait (the simulation is running; the push and tip play meanwhile) -> fall (playback) -> gone
 *   return -> back on the shelf        flight -> desk -> flight -> back on the shelf
 */

const Z_BACK = -(BOOK_DEPTH + 26) + 4; // the band in front of the plank the solver knows (row space): the shelf's own depth...
const Z_FRONT = 307; // ...to a book and a half's depth in front of the plank
/** the solver's ground: far below anything the stage can show (a fall ends at the stage's bottom edge) */
const GROUND_Y = -4000;
const FAN_PARTS = 5;
// the desk's book: out of its slot (tipping a little, then straight), up in an arc, turning to
// face the reader, and down onto the desk; the same way back to the exact slot
const PULL_MS = 500;
const ARC_MS = 700;
const LAND_MS = 200;
const SHELVE_MS = 1100;
const SHELVE_FAST_MS = 600;
const FAST_MS = 600;
const PULL_D = BOOK_DEPTH * 0.8;
const PULL_TIP = (10 * Math.PI) / 180;
const DESK_TILT = (12 * Math.PI) / 180;
const DESK_ROLL = (-3 * Math.PI) / 180;
/** the burst simulation */
const SIM_HZ = 100;
const SIM_S = 2.0;
const SIM_EVERY = 2;
const JOB_TIMEOUT_MS = 4000;
const STAGGER_MS = 250;
/** the fall's staging: a quick push to the plank's edge, a tip over it, then the solver */
const PUSH_S = 0.12;
const TIP_S = 0.16;
const TIP_DEG = 42;
/** the playback joins whatever the page showed: the pose offset at the join eases away over this long (longer for a bigger offset) */
const JOIN_MS = 150;
const JOIN_MAX_MS = 480;
/** a fall without the solver (its worker missing or lost): a plain tumble under gravity (row units/s², mm-ish) */
const DROP_G = 9810;

type State = "wait" | "fall" | "return" | "flight" | "desk";
/** a book's way to / from the desk (world space; the targets are read live each frame) */
type Flight = {
  to: "desk" | "shelf";
  t0: number;
  dur: number;
  /** the pull-out stage (ms) when it leaves its shelf slot */
  pull: number;
  /** where it left from */
  p0: THREE.Vector3;
  q0: THREE.Quaternion;
  /** where the pull-out ended (frozen when the arc starts) */
  p1: THREE.Vector3 | null;
  q1: THREE.Quaternion | null;
  arc: number;
  /** the hover's lift (0..1) a shelf book was showing when it left: the pull-out starts from it */
  lift: number;
  /** when (ms into the flight) the turn toward the reader begins: the arc's start, or a little later if the cover was not ready */
  turnFrom?: number;
};
/** how a book's bindings are sprung for its fall: shut, or flopping open (a tent, or fanned) */
type Kind = "closed" | "tent" | "fanned";
export type PartKind = "whole" | "base" | "pages" | "cover" | "fan";
export type RenderPart = { kind: PartKind; half: THREE.Vector3; pos: THREE.Vector3; quat: THREE.Quaternion };
type Part = { kind: PartKind; half: THREE.Vector3; rel: { p: THREE.Vector3; q: THREE.Quaternion }; pos: THREE.Vector3; quat: THREE.Quaternion };
/** a recorded trajectory being played back (its frames arrive in chunks as the worker simulates them) */
type Traj = {
  jobId: number;
  /** how many frames have arrived (the playback never reads past them) */
  received: number;
  t0: number;
  hz: number;
  every: number;
  frames: number;
  /** this faller's offset (floats) into a frame, and its part count */
  offset: number;
  parts: number;
  stride: number;
  data: Float32Array;
  /**
   * the playback joining what the page showed (its own push and tip, then a free fall of its
   * own while the worker was still at it): the pose offset at the join, per part, eased away
   * over `ms` on the simulated path
   */
  join: { t0: number; ms: number; dp: THREE.Vector3[]; dq: THREE.Quaternion[] } | null;
  /** the pose shown before the first frame of this path is read (the join is measured against it), and the frame of this path it belongs to */
  joinFrom?: Part[] | null;
  joinF?: number;
};
export type GroundItem = {
  id: string;
  e: Essay;
  key: number;
  state: State;
  kind: Kind;
  /** part 0 is the body of reference (the base of a compound, or the whole closed book) */
  parts: Part[];
  /** the book's centre relative to part 0, in part 0's frame */
  cOff: THREE.Vector3;
  /** it fell as separate hinged bodies */
  hinged: boolean;
  /** world poses for drawing, rebuilt every frame (fan leaves included) */
  render: RenderPart[];
  /** world pose of the book centre (for returns and the desk) */
  wc: THREE.Vector3;
  wq: THREE.Quaternion;
  /** where it belongs: off the shelf, or a shelf book drawn here (on the desk, in flight: its slot stays empty) */
  origin: "shelf" | "ground";
  flight: Flight | null;
  /** the desk shadow's strength under it (0 off the desk) */
  deskAlpha: number;
  /** waiting for its fall: when the wait began, the shelf pose it is pushed and tipped from, and the push */
  waitAt: number;
  stagedFrom: Part[] | null;
  pushDz: number;
  tipDeg: number;
  tipYaw: number;
  vel: THREE.Vector3;
  ang: THREE.Vector3;
  startAt: number;
  traj: Traj | null;
  ret: { p0: THREE.Vector3; q0: THREE.Quaternion; t0: number; dur: number; arc: number; rx: number } | null;
  /** a fall without the solver: a plain tumble from this centre pose */
  drop: { p0: THREE.Vector3; q0: THREE.Quaternion; t0: number } | null;
  /** the simulation job it waits for (an earlier fall's frames, abandoned when it was called back, are not its) */
  jobId?: number;
  /** caught in the air (flying back to the shelf) by the topic that drops it again: it falls from where it is */
  midAir?: boolean;
};
/** a job at the worker */
type Job = { id: number; ids: string[]; at: number; timer: number };
export type SimStats = { jobs: number; fallbacks: number; lastMs: number; maxMs: number; applyMs: number };

function cloneParts(ps: Part[]): Part[] {
  return ps.map((pt) => ({ kind: pt.kind, half: pt.half.clone(), rel: { p: pt.rel.p.clone(), q: pt.rel.q.clone() }, pos: pt.pos.clone(), quat: pt.quat.clone() }));
}

function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
function hashId(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = { x: 0, y: 0, z: 0 };
const _p2 = { x: 0, y: 0, z: 0 };
const _px = { x: 0, y: 0 };
const _at = { x: 0, z: 0, phi: 0 };
const _qq = { x: 0, y: 0, z: 0, w: 1 };
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// temporaries for the flights (the shared ones above are in use by the helpers they call)
const _fp = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _fp2 = new THREE.Vector3();
const _fq2 = new THREE.Quaternion();
const _fq3 = new THREE.Quaternion();
const _fe = new THREE.Vector3();
const _fc = new THREE.Vector3();
const _fh = new THREE.Vector3();
/** A quadratic bezier a -> b bent through c. */
function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3) {
  const v = 1 - u;
  out.set(v * v * a.x + 2 * v * u * c.x + u * u * b.x, v * v * a.y + 2 * v * u * c.y + u * u * b.y, v * v * a.z + 2 * v * u * c.z + u * u * b.z);
  return out;
}

/** The book's parts: thicknesses and centre-frame x offsets. */
function layout(e: Essay) {
  const w = e.width;
  const hardcover = e.binding === "hardcover";
  const tf = hardcover ? Math.max(2.6, w * 0.12) : 1.3;
  const tp = Math.max(1.2, (w - tf) * 0.35);
  const tb = w - tf - tp;
  return { w, h: e.height, D: BOOK_DEPTH, hardcover, tf, tp, tb, baseX: -w / 2 + tb / 2, pagesX: -w / 2 + tb + tp / 2, coverX: w / 2 - tf / 2 };
}
/** A part opened by `open` radians about the hinge at the spine edge (relative to the base). */
function openedRel(x: number, baseX: number, D: number, open: number) {
  const ax = x - baseX;
  return {
    p: new THREE.Vector3(ax + (D / 2) * Math.sin(open), 0, D / 2 - (D / 2) * Math.cos(open)),
    q: new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -open),
  };
}
/** The opening angle (radians) of a part from its pose relative to the base. */
function openingOf(rel: { q: THREE.Quaternion }) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(rel.q);
  return Math.atan2(f.x, -f.z);
}

export class GroundController implements GroundHook {
  readonly items = new Map<string, GroundItem>();
  /** every book off the shelf because of the topic / read filter: fallen out of view, or never shown */
  private readonly grounded = new Set<string>();
  private nextKey = 1;
  /** the ring the row space wraps on: the whole catalogue's shelf, so a faller never wraps while a short row is up */
  private readonly ring: number;
  private lastNow = 0;
  /** the worker that runs the burst simulations */
  private worker: Worker | null = null;
  private workerReady = false;
  private jobs = new Map<number, Job>();
  private nextJob = 1;
  readonly stats: SimStats = { jobs: 0, fallbacks: 0, lastMs: 0, maxMs: 0, applyMs: 0 };
  /** debug: frames over 50 ms the clock absorbed */
  stalls = 0;
  /** the last update had something moving (a long gap after an idle update is the loop having rested, not a stall) */
  private lastActive = false;

  /** Is a world point in view? (the canvas provides it) */
  inView: (p: THREE.Vector3) => boolean = () => true;
  /** where the desk's book slot is (stage px); the page provides it while a desk is open */
  deskTarget: (() => DeskRect | null) | null = null;
  /** a book landed on the desk (true) or left it (false) */
  onDesk: (id: string, on: boolean) => void = () => {};
  /** a book is flying to or from the desk (the page fades the caption's text meanwhile) */
  onFlying: (flying: boolean) => void = () => {};
  /** the scene makes a book's cover ready to show large (baked, painted, uploaded), now */
  prepareCover: (id: string) => void = () => {};
  /** whether a book's cover is ready to show large (the turn toward the reader waits for it, briefly) */
  coverReady: (id: string) => boolean = () => true;
  private flyingNow = false;
  /** how many fallers in view get hinged bodies (the quality tier decides) */
  hingedLimit = 40;
  /** debug counts for the report */
  hingedCount = 0;
  get stepMs() {
    return this.stats.lastMs;
  }
  get physicsReady() {
    return this.workerReady;
  }
  get maxStepMs() {
    return this.stats.maxMs;
  }
  resetStepStats() {
    this.stats.maxMs = 0;
  }

  private readonly engine: ShelfEngine3D;
  private readonly byId: Map<string, Essay>;

  constructor(engine: ShelfEngine3D, byId: Map<string, Essay>) {
    this.engine = engine;
    this.byId = byId;
    this.ring = Math.max(4000, new Row([...byId.values()]).S);
  }

  /** Is this book off the shelf because of the filter (fallen, flying back, or never shown)? */
  has(id: string) {
    return this.grounded.has(id);
  }
  /** Books outside the filter that are on neither the shelf nor the ground (a search had narrowed the shelf): off the shelf too. */
  ground(ids: string[]) {
    for (const id of ids) this.grounded.add(id);
  }
  /** how many books are off the shelf */
  get count() {
    return this.grounded.size;
  }
  hiddenIds() {
    return [...this.items.values()].filter((it) => it.origin === "shelf").map((it) => it.id);
  }

  // ------------------------------------------------------------ space

  /** Row-space arc offset of a row x from the view centre (wrapped on the catalogue-long ring). */
  private sOf(x: number) {
    const S = this.ring;
    return ((((x - this.engine.viewPos + S / 2) % S) + S) % S) - S / 2;
  }
  /** Row space -> world (onto the drum). */
  toWorld(p: THREE.Vector3, q: THREE.Quaternion, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const s = this.sOf(p.x);
    const a = this.engine.drum.at(s, _at);
    const nx = Math.sin(a.phi);
    const nz = Math.cos(a.phi);
    outP.set(a.x + nx * p.z, p.y, a.z + nz * p.z);
    outQ.setFromAxisAngle(Y_AXIS, a.phi).multiply(q);
  }
  /** World x/z -> row space (x along the shelf, z out from it). */
  private toRow(wx: number, wz: number, out: { x: number; z: number }) {
    const drum = this.engine.drum;
    const s = drum.sAtX(wx);
    const a = drum.at(s, { x: 0, z: 0, phi: 0 });
    out.z = (wx - a.x) * Math.sin(a.phi) + (wz - a.z) * Math.cos(a.phi);
    out.x = this.engine.viewPos + s;
  }

  // ----------------------------------------------------------- worker

  /** Prefetch the simulation worker (idle, after the shelf has loaded). */
  loadPhysics(): Promise<void> {
    this.getWorker();
    return Promise.resolve();
  }
  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" || this.workerFailed) return null;
    try {
      const w = new Worker(new URL("./simWorker.ts", import.meta.url));
      w.onmessage = (ev: MessageEvent<SimResult | SimChunk | { id: number; warm?: true; error?: string }>) => this.onResult(ev.data);
      // the worker's script didn't load (blocked, a stale deploy) or it crashed: no
      // simulation from now on; whatever waits on it tumbles out plainly
      w.onerror = () => this.failWorker("the simulation worker failed to load");
      w.onmessageerror = () => this.failWorker("the simulation worker sent an unreadable message");
      w.postMessage({ id: 0, warm: true });
      this.worker = w;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }
  private workerFailed = false;
  private failWorker(why: string) {
    if (!this.workerFailed) console.warn(`Interesting Reads: ${why}; books tumble out without a simulation.`);
    this.workerFailed = true;
    this.workerReady = false;
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.jobs.keys()]) this.failJob(id);
  }
  /** The items a job still speaks for: waiting for it, or playing its frames (not retargeted since). */
  private liveOf(job: Job): (GroundItem | null)[] {
    return job.ids.map((id) => {
      const it = this.items.get(id);
      if (!it) return null;
      if (it.state === "wait") return it.jobId === job.id ? it : null;
      if (it.state === "fall" && it.traj && it.traj.jobId === job.id) return it;
      return null;
    });
  }
  /** A job that never answered: its books tumble out plainly. */
  private failJob(id: number) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    window.clearTimeout(job.timer);
    for (const it of this.liveOf(job)) if (it) this.dropPlainly(it);
    this.stats.fallbacks++;
    this.engine.requestFrame();
  }
  private spec(): FloorSpec {
    const span = 1e5;
    const mid = this.engine.viewPos;
    return {
      hz: SIM_HZ,
      floorY: GROUND_Y,
      xMin: mid - span,
      xMax: mid + span,
      zBack: Z_BACK,
      zFront: Z_FRONT,
      plankBack: -(BOOK_DEPTH + 26),
      plankFront: PLANK_FRONT,
      lip: LIP,
    };
  }
  private spec3(it: GroundItem, i: number): PartSpec {
    const pt = it.parts[i];
    return { half: { x: pt.half.x, y: pt.half.y, z: pt.half.z }, pos: { x: pt.pos.x, y: pt.pos.y, z: pt.pos.z }, quat: { x: pt.quat.x, y: pt.quat.y, z: pt.quat.z, w: pt.quat.w } };
  }
  /** The hinges of a split book, with the binding's rest angle and spring. */
  private hinges(it: GroundItem): HingeSpec[] {
    const L = layout(it.e);
    // the binding's rest angle sets how the book wants to flop as it tumbles: shut, or open
    // (a tent, or fanned); hardcovers are stiffer than paperbacks
    const d = (deg: number) => (-deg * Math.PI) / 180;
    const closed = it.kind === "closed";
    const coverRest = closed ? 0 : it.kind === "tent" ? d(75) : d(115);
    const pagesRest = closed ? 0 : it.kind === "tent" ? d(25) : d(38);
    const stiff = closed ? (L.hardcover ? 40 : 18) : L.hardcover ? 50 : 60;
    const damp = closed ? (L.hardcover ? 3 : 1.5) : L.hardcover ? 5 : 4;
    const hinge = (child: number, x: number, maxOpen: number, rest: number, k: number): HingeSpec => ({
      child,
      anchorParent: { x: x - L.baseX, y: 0, z: L.D / 2 },
      anchorChild: { x: 0, y: 0, z: L.D / 2 },
      min: -maxOpen,
      max: 0.01,
      rest,
      stiffness: k,
      damping: damp,
    });
    return [hinge(1, L.pagesX, (80 * Math.PI) / 180, pagesRest, stiff * 0.6), hinge(2, L.coverX, (150 * Math.PI) / 180, coverRest, stiff)];
  }
  /** Run a fall for these waiting items (a deterministic seed per set). */
  private postFall(ids: string[]) {
    const w = this.getWorker();
    const items = ids.map((id) => this.items.get(id)).filter((it): it is GroundItem => !!it && it.state === "wait");
    if (!items.length) return;
    if (!w) {
      for (const it of items) this.dropPlainly(it);
      this.stats.fallbacks++;
      return;
    }
    const r = rnd(hashId(ids.join("|")));
    const now = performance.now();
    const order = items.slice().sort((a, b) => Math.abs(this.sOf(a.parts[0].pos.x)) - Math.abs(this.sOf(b.parts[0].pos.x)));
    const fallers: SimJob["fallers"] = [];
    for (const it of items) {
      const near = order.indexOf(it);
      // the push and the tip play on the page the moment the fall is asked for (the worker's
      // first frames are the very same motion, so its result takes over seamlessly)
      if (!it.stagedFrom) {
        it.stagedFrom = this.snapshot(it);
        it.waitAt = now;
      }
      // (the job is built from the shelf pose; what the page shows meanwhile stays as it is)
      const shown = it.parts;
      it.parts = it.stagedFrom;
      // pushed to the plank's edge and tipped over it; then it falls with the tip's pitch
      // (2.5-5 rad/s, a slight twist), held back a touch so it drops close under the edge; the
      // nearest get a little more air time (a weaker hold-back)
      this.centreOf(it, _v, _q);
      it.vel.set((r() - 0.5) * 40, -30, -(30 + r() * 130) + (near < 6 ? 30 : 0));
      it.ang.set(2.5 + r() * 2.5, (r() < 0.5 ? 1 : -1) * (0.5 + r() * 1.2), (r() - 0.5) * 0.5);
      // (the stagger, tip and yaw are the book's own: the page is already playing them)
      const stagger = rnd(it.key * 31 + 7);
      it.startAt = stagger() * STAGGER_MS;
      it.tipDeg = TIP_DEG + (stagger() - 0.5) * 8;
      it.tipYaw = (stagger() - 0.5) * 0.07;
      it.pushDz = PLANK_FRONT + 8 - _v.z;
      if (it.midAir) {
        it.vel.set(0, 0, 0);
        it.ang.set((r() - 0.5) * 0.6, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
        it.startAt = 0;
        it.tipDeg = 0;
        it.tipYaw = 0;
        it.pushDz = 0;
      }
      fallers.push({
        parts: it.parts.map((_, i) => this.spec3(it, i)),
        hinges: it.parts.length > 1 ? this.hinges(it) : null,
        linvel: { x: it.vel.x, y: it.vel.y, z: it.vel.z },
        angvel: { x: it.ang.x, y: it.ang.y, z: it.ang.z },
        start: Math.max(1, Math.round((it.startAt / 1000) * SIM_HZ)),
        push: it.midAir ? null : { dz: it.pushDz, steps: Math.round(PUSH_S * SIM_HZ) },
        tip: it.midAir ? null : { deg: it.tipDeg, steps: Math.round(TIP_S * SIM_HZ), pivotZ: PLANK_FRONT, yaw: it.tipYaw },
        hold: 1,
        ccd: it.parts.length === 1,
      });
      it.parts = shown;
    }
    const job: SimJob = {
      id: this.nextJob++,
      spec: this.spec(),
      fixed: [],
      fallers,
      steps: Math.round(SIM_S * SIM_HZ),
      every: SIM_EVERY,
      restV: 60,
      restW: 1.2,
    };
    this.lastJob = job;
    this.stats.jobs++;
    // (a job unanswered for 4 s is given up: the books tumble out plainly)
    const timer = window.setTimeout(() => this.failJob(job.id), JOB_TIMEOUT_MS);
    this.jobs.set(job.id, { id: job.id, ids: items.map((it) => it.id), at: now, timer });
    for (const it of items) it.jobId = job.id;
    w.postMessage(job);
  }
  /** debug / tests: the last job sent to the worker */
  lastJob: SimJob | null = null;

  private onResult(msg: SimResult | SimChunk | { id: number; warm?: true; error?: string }) {
    if ("warm" in msg && msg.warm) {
      this.workerReady = true;
      return;
    }
    const job = this.jobs.get(msg.id);
    if (!job) return;
    if ("chunk" in msg) {
      this.onChunk(job, msg);
      return;
    }
    this.jobs.delete(msg.id);
    window.clearTimeout(job.timer);
    const live = this.liveOf(job);
    if (!("samples" in msg)) {
      for (const it of live) if (it) this.dropPlainly(it);
      this.stats.fallbacks++;
      this.engine.requestFrame();
      return;
    }
    const res = msg;
    this.stats.lastMs = res.ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, res.ms);
    const now = performance.now();
    this.takeFrames(job, live, res, res.samples, res.frames, now);
    for (const it of live) if (it) this.catchUp(it, now);
    res.parts.forEach((n, i) => {
      const it = live[i];
      if (!it || it.traj?.jobId !== job.id) return;
      it.stagedFrom = null;
      it.hinged = n > 1;
      if (n > 1) this.hingedCount++;
    });
    this.engine.requestFrame();
  }
  /** Frames of a job as the worker simulates them: the playback starts as soon as they reach the page's clock. */
  private onChunk(job: Job, c: SimChunk) {
    const live = this.liveOf(job);
    const now = performance.now();
    if (c.k0 === 0) this.takeFrames(job, live, c, null, 0, now);
    for (const it of live) {
      const tr = it && it.traj?.jobId === job.id ? it.traj : null;
      if (!tr) continue;
      tr.data.set(c.chunk, c.k0 * tr.stride);
      tr.received = Math.max(tr.received, c.k1);
    }
    for (const it of live) if (it) this.catchUp(it, now);
    this.engine.requestFrame();
  }
  /**
   * Gives the job's books their trajectories (a full-size buffer that chunks fill in, or the
   * finished one). A book keeps showing what it shows (the staged push and tip) until the
   * path has reached the page's clock (`catchUp`).
   */
  private takeFrames(job: Job, live: (GroundItem | null)[], src: { hz: number; every: number; frames: number; parts: number[] }, data: Float32Array | null, received: number, now: number) {
    const stride = src.parts.reduce((a, b) => a + b, 0) * 7;
    let offset = 0;
    src.parts.forEach((n, i) => {
      const it = live[i];
      if (it) {
        let tr = it.traj?.jobId === job.id ? it.traj : null;
        if (!tr) {
          // the playback runs on the page's own clock from the click (the worker's push and
          // tip are the page's to the step)
          tr = {
            jobId: job.id,
            received: 0,
            t0: it.stagedFrom ? it.waitAt : now,
            hz: src.hz,
            every: src.every,
            frames: src.frames,
            offset,
            parts: n,
            stride,
            data: data ?? new Float32Array(src.frames * stride),
            join: null,
          };
          it.traj = tr;
        }
        if (data) {
          tr.data = data;
          tr.received = received;
        }
      }
      offset += n * 7;
    });
  }
  /**
   * The path waiting for this book has reached the page's clock: it takes over from the pose
   * shown, with the offset between the two eased away over a few frames (see `join`), so
   * there is no kink and no jump.
   */
  private catchUp(it: GroundItem, now: number) {
    const cand = it.state === "wait" ? it.traj : null;
    if (!cand) return;
    if (cand.parts !== it.parts.length) {
      // (the path was built for another body than the one shown, split or whole: the shown
      // one is re-made in the path's form about the same centre, rather than wait for ever)
      this.centreOf(it, _v, _q);
      this.setParts(it, cand.parts > 1 ? "split" : "whole", 0, 0);
      this.setCentre(it, _v, _q);
      if (cand.parts !== it.parts.length) return;
    }
    const f = ((now - cand.t0) / 1000) * (cand.hz / cand.every);
    if (cand.received < cand.frames && cand.received - 1 < f + 1) return;
    cand.join = { t0: 0, ms: 0, dp: [], dq: [] };
    cand.joinFrom = cloneParts(it.parts);
    // (the pose shown is the last frame's: the offset is taken against the path there, so the
    // book carries on at the path's pace from the very next frame, with no frame lost)
    cand.joinF = ((Math.max(cand.t0, this.lastNow || now) - cand.t0) / 1000) * (cand.hz / cand.every);
    this.joinLog.push({ id: it.id, t: Math.round(now - cand.t0), job: cand.jobId, f: +f.toFixed(1), received: cand.received, joinF: +cand.joinF.toFixed(1), parts: it.parts.length });
    if (this.joinLog.length > 60) this.joinLog.shift();
    it.state = "fall";
  }
  /** debug: frames the playback wanted before the worker had sent them (it waits at the last one) */
  clampLog: { id: string; f: number; received: number; job: number; t: number }[] = [];
  /** debug / tests: the hand-offs from the staging to a simulated path (ms after the click, frame, frames in) */
  joinLog: { id: string; t: number; job: number; f: number; received: number; joinF?: number; parts?: number; far?: number; fNow?: number; ms?: number }[] = [];

  // -------------------------------------------------------- playback

  /** Reads frame f of a trajectory into the item's parts (and the parts' relative poses); never past the frames that have arrived. */
  private readFrame(it: GroundItem, tr: Traj, f: number) {
    const last = Math.max(0, Math.min(tr.frames, tr.received) - 1);
    if (f > last + 0.5 && tr.received < tr.frames) this.clampLog.push({ id: it.id, f: +f.toFixed(1), received: tr.received, job: tr.jobId, t: Math.round(performance.now() - tr.t0) });
    if (this.clampLog.length > 40) this.clampLog.shift();
    const f0 = Math.max(0, Math.min(last, Math.floor(f)));
    const f1 = Math.min(last, f0 + 1);
    const a = Math.max(0, Math.min(1, f - f0));
    const d = tr.data;
    for (let i = 0; i < tr.parts; i++) {
      const o0 = f0 * tr.stride + tr.offset + i * 7;
      const o1 = f1 * tr.stride + tr.offset + i * 7;
      const pt = it.parts[i];
      if (!pt) continue;
      pt.pos.set(d[o0] + (d[o1] - d[o0]) * a, d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * a, d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * a);
      _q.set(d[o0 + 3], d[o0 + 4], d[o0 + 5], d[o0 + 6]);
      _q2.set(d[o1 + 3], d[o1 + 4], d[o1 + 5], d[o1 + 6]);
      pt.quat.copy(_q).slerp(_q2, a);
    }
    this.relFromAbs(it);
  }
  /** The join's remaining offset laid over the simulated pose just read (eased away on the page's clock). */
  private applyJoin(it: GroundItem, tr: Traj, now: number) {
    const j = tr.join;
    if (!j) return;
    if (!j.ms) {
      // the join is measured now: the pose shown before this frame (kept in `joinFrom`) against
      // the path at the frame it belongs to; then the path at this frame is read again
      const shown = tr.joinFrom;
      tr.joinFrom = null;
      if (!shown || shown.length !== it.parts.length) {
        tr.join = null;
        return;
      }
      const fNow = ((now - tr.t0) / 1000) * (tr.hz / tr.every);
      const fAt = tr.joinF ?? fNow;
      if (fAt < fNow) this.readFrame(it, tr, fAt);
      let far = 0;
      for (let k = 0; k < it.parts.length; k++) {
        j.dp.push(shown[k].pos.clone().sub(it.parts[k].pos));
        j.dq.push(shown[k].quat.clone().multiply(_q.copy(it.parts[k].quat).invert()));
        far = Math.max(far, j.dp[k].length());
      }
      if (fAt < fNow) this.readFrame(it, tr, fNow);
      j.t0 = now;
      j.ms = Math.min(JOIN_MAX_MS, JOIN_MS + far * 1.5);
      const log = this.joinLog[this.joinLog.length - 1];
      if (log && log.id === it.id) {
        log.far = +far.toFixed(1);
        log.fNow = +fNow.toFixed(1);
        log.ms = Math.round(j.ms);
      }
    }
    const w = Math.min(1, (now - j.t0) / j.ms);
    if (w >= 1) {
      tr.join = null;
      return;
    }
    const k = 1 - easeInOut(w);
    for (let i = 0; i < it.parts.length; i++) {
      const dp = j.dp[i];
      const dq = j.dq[i];
      if (!dp || !dq) continue;
      const pt = it.parts[i];
      pt.pos.addScaledVector(dp, k);
      _q.copy(dq).multiply(pt.quat);
      pt.quat.slerp(_q, k);
    }
    // (the offset is laid over a path that clears the plank; the sum may not: a corner deep in
    // the wood gives up that much of the offset, back toward the path, a hair of it is pushed out)
    if (k > 0 && this.plankDepth(it) > 6) {
      const fNow = ((now - tr.t0) / 1000) * (tr.hz / tr.every);
      for (const kk of [k * 0.5, k * 0.25, 0]) {
        this.readFrame(it, tr, fNow);
        for (let i = 0; i < it.parts.length; i++) {
          const dp = j.dp[i];
          const dq = j.dq[i];
          if (!dp || !dq) continue;
          const pt = it.parts[i];
          pt.pos.addScaledVector(dp, kk);
          _q.copy(dq).multiply(pt.quat);
          pt.quat.slerp(_q, kk);
        }
        if (kk === 0 || this.plankDepth(it) <= 6) break;
      }
    }
    this.keepOutOfPlank(it);
    this.relFromAbs(it);
  }
  /** How far (row units) the deepest corner of the book sits inside the plank's wood (0 when clear). */
  private plankDepth(it: GroundItem) {
    const zBack = -(BOOK_DEPTH + 26);
    let deep = 0;
    for (const pt of it.parts)
      for (let c = 0; c < 8; c++) {
        _v.set((c & 1 ? 1 : -1) * pt.half.x, (c & 2 ? 1 : -1) * pt.half.y, (c & 4 ? 1 : -1) * pt.half.z).applyQuaternion(pt.quat).add(pt.pos);
        if (_v.y < 0 && _v.y > -LIP && _v.z > zBack && _v.z < PLANK_FRONT) deep = Math.max(deep, Math.min(-_v.y, PLANK_FRONT - _v.z));
      }
    return deep;
  }
  /**
   * A corner inside the plank's slab is pushed out: forward past the front face, or, when the
   * whole book is already under the plank's top, down past the lip, whichever is shorter (a
   * book with corners still above the plank is never shoved down: that would put them in).
   */
  private keepOutOfPlank(it: GroundItem) {
    const zBack = -(BOOK_DEPTH + 26);
    let out = 0;
    let down = 0;
    let under = true;
    for (const pt of it.parts)
      for (let c = 0; c < 8; c++) {
        _v.set((c & 1 ? 1 : -1) * pt.half.x, (c & 2 ? 1 : -1) * pt.half.y, (c & 4 ? 1 : -1) * pt.half.z).applyQuaternion(pt.quat).add(pt.pos);
        if (_v.z <= zBack || _v.z >= PLANK_FRONT) continue;
        if (_v.y >= 0) under = false;
        // (a corner on the plank's top is not in it: a path frame's float32 pose puts a standing book's
        // bottom a few microns under, and a book standing on the plank must stay where it stands)
        if (_v.y < -0.75 && _v.y > -LIP) {
          out = Math.max(out, PLANK_FRONT - _v.z);
          down = Math.max(down, _v.y + LIP);
        }
      }
    if (!out && !down) return;
    if (under && down < out) for (const pt of it.parts) pt.pos.y -= down;
    else for (const pt of it.parts) pt.pos.z += out;
  }
  private relFromAbs(it: GroundItem) {
    const b = it.parts[0];
    _q.copy(b.quat).invert();
    for (let i = 1; i < it.parts.length; i++) {
      const pt = it.parts[i];
      pt.rel.p.copy(pt.pos).sub(b.pos).applyQuaternion(_q);
      pt.rel.q.copy(_q).multiply(pt.quat);
    }
  }
  /** The projected top (stage px) of an item's parts. */
  projectedTop(it: GroundItem) {
    let top = Infinity;
    for (const pt of it.parts)
      for (let c = 0; c < 8; c++) {
        _v.set((c & 1 ? 1 : -1) * pt.half.x, (c & 2 ? 1 : -1) * pt.half.y, (c & 4 ? 1 : -1) * pt.half.z).applyQuaternion(pt.quat).add(pt.pos);
        this.toWorld(_v, _q.identity(), _v2, _q2);
        top = Math.min(top, this.engine.project(_v2.x, _v2.y, _v2.z, _px).y);
      }
    return top;
  }
  /** A faller is gone once all of it has passed the stage's bottom edge (the canvas ends there, its last 16 px masked). */
  private belowStage(it: GroundItem) {
    return this.projectedTop(it) > this.engine.view.h;
  }
  /** debug: where a book is along the shelf's arc (from the view centre), its row depth and its block's bottom */
  arcOf(it: GroundItem): { s: number; z: number; bottom: number } {
    this.centreOf(it, _v, _q);
    let bottom = Infinity;
    for (const pt of it.parts)
      for (let c = 0; c < 8; c++) {
        _v2.set((c & 1 ? 1 : -1) * pt.half.x, (c & 2 ? 1 : -1) * pt.half.y, (c & 4 ? 1 : -1) * pt.half.z).applyQuaternion(pt.quat).add(pt.pos);
        bottom = Math.min(bottom, _v2.y);
      }
    return { s: this.sOf(_v.x), z: _v.z, bottom };
  }
  private snapshot(it: GroundItem): Part[] {
    return cloneParts(it.parts);
  }

  // --------------------------------------------------------------- parts

  private item(id: string): GroundItem | null {
    const e = this.byId.get(id);
    if (!e) return null;
    const h = hashId(id);
    const r = (h % 1000) / 1000;
    const kind: Kind = r < 0.55 ? "closed" : r < 0.8 ? "tent" : "fanned";
    const it: GroundItem = {
      id,
      e,
      key: this.nextKey++,
      state: "wait",
      kind,
      parts: [],
      cOff: new THREE.Vector3(),
      hinged: false,
      render: [],
      wc: new THREE.Vector3(),
      wq: new THREE.Quaternion(),
      origin: "ground",
      flight: null,
      deskAlpha: 0,
      waitAt: 0,
      stagedFrom: null,
      pushDz: 0,
      tipDeg: TIP_DEG,
      tipYaw: 0,
      vel: new THREE.Vector3(),
      ang: new THREE.Vector3(),
      startAt: 0,
      traj: null,
      ret: null,
      drop: null,
    };
    this.setParts(it, "whole", 0, 0);
    return it;
  }
  /**
   * Give the item its parts: one closed box, or base + pages + cover with the page group and
   * the cover opened by `pagesOpen` / `coverOpen` radians (relative poses; the absolute ones
   * follow part 0). The book's centre stays where it was.
   */
  private setParts(it: GroundItem, mode: "whole" | "split", pagesOpen: number, coverOpen: number) {
    const L = layout(it.e);
    const mk = (kind: PartKind, half: THREE.Vector3, rel: { p: THREE.Vector3; q: THREE.Quaternion }): Part => ({ kind, half, rel, pos: new THREE.Vector3(), quat: new THREE.Quaternion() });
    const base0 = it.parts[0];
    const basePos = base0 ? base0.pos.clone() : new THREE.Vector3();
    const baseQuat = base0 ? base0.quat.clone() : new THREE.Quaternion();
    const centre = basePos.clone().add(it.cOff.clone().applyQuaternion(baseQuat));
    if (mode === "whole") {
      it.parts = [mk("whole", new THREE.Vector3(L.w / 2, L.h / 2, L.D / 2), { p: new THREE.Vector3(), q: new THREE.Quaternion() })];
      it.cOff.set(0, 0, 0);
    } else {
      it.parts = [
        mk("base", new THREE.Vector3(L.tb / 2, L.h / 2, L.D / 2), { p: new THREE.Vector3(), q: new THREE.Quaternion() }),
        mk("pages", new THREE.Vector3(L.tp / 2, L.h / 2, L.D / 2), openedRel(L.pagesX, L.baseX, L.D, pagesOpen)),
        mk("cover", new THREE.Vector3(L.tf / 2, L.h / 2, L.D / 2), openedRel(L.coverX, L.baseX, L.D, coverOpen)),
      ];
      it.cOff.set(-L.baseX, 0, 0);
    }
    it.parts[0].pos.copy(centre).sub(it.cOff.clone().applyQuaternion(baseQuat));
    it.parts[0].quat.copy(baseQuat);
    this.placeParts(it);
  }
  /** Absolute part poses from part 0 and the relative ones. */
  private placeParts(it: GroundItem) {
    const b = it.parts[0];
    for (let i = 1; i < it.parts.length; i++) {
      const pt = it.parts[i];
      pt.pos.copy(pt.rel.p).applyQuaternion(b.quat).add(b.pos);
      pt.quat.copy(b.quat).multiply(pt.rel.q);
    }
  }
  /** The book's centre pose (row space). */
  private centreOf(it: GroundItem, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const b = it.parts[0];
    outP.copy(it.cOff).applyQuaternion(b.quat).add(b.pos);
    outQ.copy(b.quat);
  }
  private setCentre(it: GroundItem, p: THREE.Vector3, q: THREE.Quaternion) {
    const b = it.parts[0];
    b.quat.copy(q);
    b.pos.copy(p).sub(it.cOff.clone().applyQuaternion(q));
    this.placeParts(it);
  }

  // ------------------------------------------------------------ changes

  /**
   * A new list: `leaving` books fall (those in view; the others are simply off the shelf),
   * `returning` ones rise into their slots from below the stage. Under reduced motion the
   * leavers vanish and the returners are the shelf's at once.
   */
  apply(leaving: LeaveInfo[], returning: string[], reduced: boolean) {
    const now = performance.now();
    const row = this.engine.row;
    this.getWorker();
    // the fallers in view nearest the centre get hinged bodies (the tier sets how many)
    const inView = leaving.filter((L) => L.s !== null).sort((a, b) => Math.abs(a.s!) - Math.abs(b.s!));
    const hingedIds = new Set(inView.slice(0, this.hingedLimit).map((L) => L.id));
    const fallers: string[] = [];
    for (const L of leaving) {
      this.grounded.add(L.id);
      const existing = this.items.get(L.id);
      if (existing) {
        // the desk's book (or one flying to or from it), or one flying back to its slot, left
        // the row: in view it falls from where it is; out of view it is simply gone
        if (existing.state === "desk") this.onDesk(existing.id, false);
        if (existing.state === "wait" || existing.state === "fall") continue;
        existing.origin = "ground";
        existing.deskAlpha = 0;
        existing.flight = null;
        existing.ret = null;
        existing.traj = null;
        existing.drop = null;
        if (reduced || !this.inView(existing.wc)) {
          this.items.delete(existing.id);
          continue;
        }
        this.rowPoseFromWorld(existing);
        existing.state = "wait";
        existing.stagedFrom = null;
        this.centreOf(existing, _v, _q);
        // (caught in the air it drops from where it is, with no push and no tip, unless it is
        // up on the plank already, when it leaves as a shelf book does)
        existing.midAir = _v.y < -LIP / 2 || _v.z > PLANK_FRONT;
        fallers.push(existing.id);
        continue;
      }
      if (reduced || L.s === null) continue;
      const it = this.item(L.id);
      if (!it) continue;
      this.items.set(L.id, it);
      // standing in its shelf place (row space: a flat shelf)
      const L2 = layout(it.e);
      const lean = (-(it.e.lean || 0) * Math.PI) / 180;
      const q = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, lean);
      const centre = new THREE.Vector3(0, L2.h / 2, -L2.D / 2).applyQuaternion(q).add(new THREE.Vector3(this.engine.viewPos + L.s, 0, it.e.depth));
      if (hingedIds.has(L.id)) this.setParts(it, "split", 0, 0);
      else this.setParts(it, "whole", 0, 0);
      this.setCentre(it, centre, q);
      it.state = "wait";
      it.traj = null;
      it.stagedFrom = null;
      it.midAir = false;
      fallers.push(it.id);
    }
    if (fallers.length) this.postFall(fallers);
    let i = 0;
    for (const id of returning) {
      let it: GroundItem | null | undefined = this.items.get(id);
      const r = rnd((it?.key ?? hashId(id)) * 17 + 11);
      // the copy of its slot it flies to (a short looping row shows a slot twice: the choice holds)
      const kk = row.kOfId(id);
      const rx = kk === undefined ? this.engine.pos : row.centerOf(row.nearestV(kk, this.engine.pos));
      if (!it) {
        // off the shelf: it rises into its slot from below the stage
        if (reduced) {
          this.grounded.delete(id);
          continue;
        }
        it = this.item(id);
        if (!it || !this.startBelow(it, rx, r, _fp, _fq)) {
          this.grounded.delete(id);
          continue;
        }
        this.items.set(id, it);
        it.state = "return";
        it.wc.copy(_fp);
        it.wq.copy(_fq);
      }
      it.traj = null;
      it.drop = null;
      if (reduced || it.state === "wait") {
        this.finishReturn(it);
        continue;
      }
      const flying = it.state === "flight" || it.state === "desk";
      if (flying) {
        // lifted to the desk (or on its way): it flies to its slot from where it is
        if (it.state === "desk") this.onDesk(it.id, false);
        it.flight = null;
        it.deskAlpha = 0;
      } else if (it.state === "fall") {
        // caught in the air: up again from where it is, shut
        this.centreOf(it, _v, _q);
        this.setParts(it, "whole", 0, 0);
        this.setCentre(it, _v, _q);
        this.toWorld(_v, _q, it.wc, it.wq);
      }
      // (a returner retargeted keeps flying from where it is)
      const p0 = it.wc.clone();
      const q0 = it.wq.clone();
      const dist = this.engine.slotPose(id, _p, _qq, rx) ? p0.distanceTo(_v.set(_p.x, _p.y, _p.z)) : 600;
      it.origin = "ground";
      it.state = "return";
      // a short stagger and an arc that takes at most 800 ms to just in front of the slot; with
      // books falling in view the returns wait until those have cleared the plank, and the slide
      // into the slot waits for the row to have closed up (see "return" in update)
      const wait = inView.length ? this.engine.morphDelayMs : 0;
      it.ret = { p0, q0, t0: now + wait + Math.min(200, i * 14), dur: Math.min(800, 500 + dist * 0.22), arc: 90 + Math.min(220, dist * 0.12), rx };
      i++;
    }
    this.stats.applyMs = performance.now() - now;
    this.engine.requestFrame();
  }
  /** Where a returner starts (world): below the stage's bottom edge under its slot, a little in front, tumbled. */
  private startBelow(it: GroundItem, rx: number, r: () => number, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    if (!this.engine.slotPose(it.id, _p, _qq, rx)) return false;
    const L = layout(it.e);
    const s = this.engine.project(_p.x, _p.y, _p.z, _px);
    const z = _p.z + 120 + r() * 80;
    // (the world point at the slot's x and depth z that shows 40 px under the stage: the book
    // hangs a book's height below it, out of sight whatever its tumble)
    const o = this.engine.unproject(s.x, this.engine.view.h + 40, z, _p2);
    outP.set(o.x + (r() - 0.5) * 80, o.y - L.h / 2 - 20, z);
    outQ.setFromEuler(new THREE.Euler((r() - 0.5) * 0.8, (r() - 0.5) * 0.8, Math.PI / 2 + (r() - 0.5) * 0.6, "YXZ"));
    return true;
  }
  /** No solver (none loaded, or it failed): a plain tumble under gravity from where the book is. */
  private dropPlainly(it: GroundItem) {
    if (it.state !== "wait" && it.state !== "fall") return;
    this.centreOf(it, _v, _q);
    it.traj = null;
    it.drop = { p0: _v.clone(), q0: _q.clone(), t0: performance.now() };
    it.state = "fall";
  }
  private finishReturn(it: GroundItem) {
    this.items.delete(it.id);
    this.grounded.delete(it.id);
    this.engine.unhide(it.id);
  }

  // --------------------------------------------------------------- frame

  update(now: number): boolean {
    // (the loop is demand-driven: after an update with nothing moving it rests, and the next
    // update may come seconds later; only a long frame while something moves is a stall)
    const gap = this.lastNow && this.lastActive ? now - this.lastNow : 0;
    if (gap > 50) {
      // a stalled frame (a compile, a page hitch): every motion carries on from where it was
      // shown, one frame along, rather than jumping ahead by the stall
      const skip = gap - 16.7;
      for (const it of this.items.values()) {
        if (it.traj) {
          it.traj.t0 += skip;
          if (it.traj.join) it.traj.join.t0 += skip;
        }
        if (it.drop) it.drop.t0 += skip;
        if (it.ret) it.ret.t0 += skip;
        if (it.state === "wait") it.waitAt += skip;
      }
      this.stalls++;
    }
    this.lastNow = now;
    if (!this.items.size) {
      this.lastActive = false;
      return false;
    }
    let active = false;
    const gone: GroundItem[] = [];
    for (const it of this.items.values()) {
      switch (it.state) {
        case "wait":
          active = true;
          if (it.stagedFrom) this.stageWait(it, now);
          break;
        case "fall": {
          active = true;
          const tr = it.traj;
          if (tr) {
            const f = ((now - tr.t0) / 1000) * (tr.hz / tr.every);
            if (f >= tr.frames - 1) {
              gone.push(it);
              break;
            }
            this.readFrame(it, tr, f);
            if (tr.join) this.applyJoin(it, tr, now);
            else this.keepOutOfPlank(it);
          } else if (it.drop) {
            const d = it.drop;
            const t = Math.max(0, (now - d.t0) / 1000);
            _v.copy(d.p0);
            _v.y -= 0.5 * DROP_G * t * t;
            _v.z += 80 * t;
            _q.copy(d.q0).multiply(_q2.setFromAxisAngle(X_AXIS, 2.5 * t));
            this.setCentre(it, _v, _q);
            this.keepOutOfPlank(it);
            if (t > 3) {
              gone.push(it);
              break;
            }
          } else {
            gone.push(it);
            break;
          }
          if (this.belowStage(it)) gone.push(it);
          break;
        }
        case "return": {
          active = true;
          const r = it.ret!;
          if (!this.engine.slotPose(it.id, _p, _qq, r.rx)) {
            this.finishReturn(it);
            break;
          }
          // up and forward to just in front of its slot (over the plank's lip); it holds there
          // until the row has closed up (a kept book may still be sliding past its slot), then in
          _fp.set(_p.x, _p.y, _p.z);
          _fq.set(_qq.x, _qq.y, _qq.z, _qq.w);
          const d1 = r.dur * 0.78;
          const d2 = r.dur - d1;
          const inAt = Math.max(r.t0 + d1, this.engine.morphEndAt + 40);
          if (now < inAt) {
            const u = easeInOut(Math.max(0, Math.min(1, (now - r.t0) / d1)));
            this.pulledPose(it, _fp, _fq, PULL_D + 40, 0, _fp2, _fq2);
            _fc.copy(r.p0).add(_fp2).multiplyScalar(0.5);
            _fc.y += r.arc;
            _fc.z += 160;
            bezier(r.p0, _fc, _fp2, u, it.wc);
            it.wq.copy(r.q0).slerp(_fq2, u);
          } else {
            const u = easeInOut(Math.min(1, (now - inAt) / d2));
            this.pulledPose(it, _fp, _fq, (PULL_D + 40) * (1 - u), 0, it.wc, it.wq);
          }
          this.renderFromWorldCentre(it, it.wc, it.wq);
          if (now >= inAt + d2) this.finishReturn(it);
          break;
        }
        case "flight": {
          active = true;
          const f = it.flight!;
          if (now < f.t0) {
            // waiting its turn (Previous / Next): where it is
            if (it.origin === "shelf" && f.to === "desk" && f.pull > 0 && this.slotWorld(it.id, _fp, _fq, f.lift)) this.pulledPose(it, _fp, _fq, 0, 0, it.wc, it.wq);
            this.renderFromWorldCentre(it, it.wc, it.wq);
            break;
          }
          if (f.to === "desk") this.flyToDesk(it, f, now);
          else this.flyToShelf(it, f, now);
          break;
        }
        case "desk": {
          // lying on the desk: it follows the slot (the desk rising in, a resize)
          if (this.deskPose(it, _fp, _fq)) {
            if (it.wc.distanceToSquared(_fp) > 0.01 || Math.abs(it.wq.dot(_fq)) < 0.99999) active = true;
            it.wc.copy(_fp);
            it.wq.copy(_fq);
          }
          it.deskAlpha = 1;
          this.renderFromWorldCentre(it, it.wc, it.wq);
          break;
        }
      }
    }
    for (const it of gone) this.items.delete(it.id);
    let flying = false;
    for (const it of this.items.values()) {
      if (it.state === "flight") flying = true;
      else if ((it.state === "wait" || it.state === "fall" || it.state === "return") && it.render.length && this.inView(it.wc)) flying = true;
    }
    if (flying !== this.flyingNow) {
      this.flyingNow = flying;
      this.onFlying(flying);
    }
    for (const it of this.items.values()) if (it.state === "wait" || it.state === "fall") this.updateWorld(it);
    this.lastActive = active;
    return active;
  }

  /**
   * Until the worker's first frames arrive (a few tens of ms): the push to the plank's edge
   * and the tip over it, kinematic, exactly as the worker stages them (its first frames), so
   * the fall is never a wait. The playback takes over from whatever this shows (see `join`).
   */
  private stageWait(it: GroundItem, now: number) {
    const from = it.stagedFrom!;
    const u = (now - it.waitAt) / 1000 - it.startAt / 1000;
    if (u <= 0) return;
    const dz = it.pushDz * easeOut(Math.max(0, Math.min(1, u / PUSH_S)));
    const k = u > PUSH_S ? easeIn(Math.max(0, Math.min(1, (u - PUSH_S) / TIP_S))) : 0;
    const a = ((it.tipDeg * Math.PI) / 180) * k;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    _fq2.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
    const yaw = it.tipYaw * k;
    _fq.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)).multiply(_fq2);
    const cx = from[0] ? from[0].pos.x : 0;
    for (let i = 0; i < it.parts.length; i++) {
      const p0 = from[i];
      const pt = it.parts[i];
      if (!p0) continue;
      const z0 = p0.pos.z + dz - PLANK_FRONT;
      const y0 = p0.pos.y;
      // the tip about the plank's edge, then a slight yaw about the book's own vertical
      const ty = y0 * ca - z0 * sa;
      const tz = PLANK_FRONT + y0 * sa + z0 * ca;
      const rx = p0.pos.x - cx;
      const rz = tz - PLANK_FRONT;
      pt.pos.set(cx + rx * Math.cos(yaw) + rz * Math.sin(yaw), ty, PLANK_FRONT - rx * Math.sin(yaw) + rz * Math.cos(yaw));
      pt.quat.copy(k ? _fq2.copy(_fq).multiply(p0.quat) : p0.quat);
    }
    this.relFromAbs(it);
  }

  // ---------------------------------------------------------- the desk

  /** A shelf slot's box pose (world). */
  private slotWorld(id: string, outP: THREE.Vector3, outQ: THREE.Quaternion, lift = 0) {
    if (!this.engine.slotPose(id, _p, _qq, undefined, lift)) return false;
    outP.set(_p.x, _p.y, _p.z);
    outQ.set(_qq.x, _qq.y, _qq.z, _qq.w);
    return true;
  }
  /**
   * A book slid `dz` out of its slot toward the reader and tipped `tip` radians about its
   * bottom front edge (the top comes forward, as a finger hooks the spine's head).
   */
  private pulledPose(it: GroundItem, slotP: THREE.Vector3, slotQ: THREE.Quaternion, dz: number, tip: number, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const L = layout(it.e);
    _fe.set(0, -L.h / 2, L.D / 2 + dz).applyQuaternion(slotQ).add(slotP);
    // (its own temporary: callers pass _fq2 as the output)
    outQ.copy(slotQ).multiply(_fq3.setFromAxisAngle(X_AXIS, tip));
    outP.set(0, L.h / 2, -L.D / 2).applyQuaternion(outQ).add(_fe);
  }
  /**
   * Where the book lies on the desk: its front cover toward the reader, spine on the left,
   * tilted back a touch and rolled a little, at the depth where its cover's width is the
   * slot's width, centred on the slot (so the 3D book lands exactly in the page's gap).
   */
  private deskPose(it: GroundItem, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const r = this.deskTarget?.();
    if (!r || !(r.w > 0)) return false;
    const L = layout(it.e);
    // (the cover's face, half the book's thickness nearer than its centre, is what should match)
    const z = this.engine.depthForScale(r.w, L.D) - L.w / 2;
    const o = this.engine.unproject(r.cx, r.cy, z, _p);
    outP.set(o.x, o.y, o.z);
    outQ.setFromAxisAngle(Y_AXIS, -Math.PI / 2);
    outQ.premultiply(_fq2.setFromAxisAngle(X_AXIS, -DESK_TILT));
    outQ.premultiply(_fq2.setFromAxisAngle(Z_AXIS, DESK_ROLL));
    return true;
  }
  private startFlight(it: GroundItem, to: Flight["to"], o: { dur: number; pull: number; delay: number; lift?: number }) {
    const now = performance.now();
    if (it.state === "desk") this.onDesk(it.id, false);
    it.state = "flight";
    it.flight = { to, t0: now + o.delay, dur: o.dur, pull: o.pull, p0: it.wc.clone(), q0: it.wq.clone(), p1: null, q1: null, arc: 0, lift: o.lift ?? 0 };
    it.ret = null;
    it.drop = null;
    it.traj = null;
    this.renderFromWorldCentre(it, it.wc, it.wq);
    this.engine.requestFrame();
  }
  /** The flight is over: on the desk, or in the slot (the shelf draws it again). */
  private arrive(it: GroundItem, to: Flight["to"]) {
    it.flight = null;
    if (to === "desk") {
      it.state = "desk";
      it.deskAlpha = 1;
      if (this.deskPose(it, _fp, _fq)) {
        it.wc.copy(_fp);
        it.wq.copy(_fq);
      }
      if (it.parts.length > 1) this.setParts(it, "whole", 0, 0);
      this.renderFromWorldCentre(it, it.wc, it.wq);
      this.onDesk(it.id, true);
    } else {
      it.deskAlpha = 0;
      if (this.slotWorld(it.id, _fp, _fq)) {
        const a = this.engine.project(it.wc.x, it.wc.y, it.wc.z, { x: 0, y: 0 });
        const b = this.engine.project(_fp.x, _fp.y, _fp.z, { x: 0, y: 0 });
        this.lastShelved = { id: it.id, d: +it.wc.distanceTo(_fp).toFixed(3), px: +Math.hypot(a.x - b.x, a.y - b.y).toFixed(3) };
      }
      this.finishReturn(it);
    }
    this.engine.requestFrame();
  }
  private flyToDesk(it: GroundItem, f: Flight, now: number) {
    const e = now - f.t0;
    const land = f.dur * (LAND_MS / (PULL_MS + ARC_MS + LAND_MS));
    const arcEnd = f.dur - land;
    if (e < f.pull) {
      // out of the slot (which may be gliding to the centre: it comes along), tipping then straightening
      const a = easeInOut(e / f.pull);
      // (on from the hover's lift and slide: fully out of the row, tipping then straightening; the turn to show the cover is the arc's)
      if (this.slotWorld(it.id, _fp, _fq, f.lift)) this.pulledPose(it, _fp, _fq, PULL_D * a, PULL_TIP * Math.sin(Math.PI * a), it.wc, it.wq);
      it.deskAlpha = 0;
    } else {
      if (!f.p1) {
        f.p1 = it.wc.clone();
        f.q1 = it.wq.clone();
      }
      if (this.deskPose(it, _fp, _fq)) {
        // hovers a touch above and in front of its place, then settles
        _fh.set(0, 16, 10).add(_fp);
        if (e < arcEnd) {
          const u = easeInOut(Math.min(1, (e - f.pull) / Math.max(1, arcEnd - f.pull)));
          if (!f.arc) f.arc = 90 + Math.min(260, f.p1.distanceTo(_fh) * 0.18);
          _fc.copy(f.p1).add(_fh).multiplyScalar(0.5);
          _fc.y += f.arc;
          _fc.z += 90;
          bezier(f.p1, _fc, _fh, u, it.wc);
          // the turn toward the reader (the cover coming into view) waits for the cover's print,
          // up to 150 ms; the spine shows meanwhile, never a blank board
          if (f.turnFrom === undefined) f.turnFrom = f.pull;
          if (e - f.pull < 150 && !this.coverReady(it.id)) f.turnFrom = Math.min(e, f.pull + 150);
          const ut = easeInOut(Math.min(1, Math.max(0, (e - f.turnFrom) / Math.max(1, arcEnd - f.turnFrom))));
          it.wq.copy(f.q1!).slerp(_fq, ut);
          it.deskAlpha = 0;
        } else {
          const tL = Math.min(1, (e - arcEnd) / Math.max(1, land));
          const u = easeOut(tL);
          it.wc.copy(_fh).lerp(_fp, u);
          it.wq.copy(_fq).premultiply(_fq2.setFromAxisAngle(X_AXIS, -0.07 * (1 - u)));
          it.deskAlpha = u;
          if (tL >= 1) {
            this.arrive(it, "desk");
            return;
          }
        }
      }
      // (no slot in the page yet: it waits where the pull-out left it)
    }
    this.renderFromWorldCentre(it, it.wc, it.wq);
  }
  private flyToShelf(it: GroundItem, f: Flight, now: number) {
    const t = Math.min(1, (now - f.t0) / f.dur);
    if (!this.slotWorld(it.id, _fp, _fq)) {
      // its slot is gone (the row changed under it): the shelf takes over where it stands
      this.arrive(it, "shelf");
      return;
    }
    const s1 = 0.78;
    it.deskAlpha = Math.max(0, 1 - t * 6);
    if (t < s1) {
      // an arc to just in front of the slot, turning back to its shelf pose
      const u = easeInOut(t / s1);
      this.pulledPose(it, _fp, _fq, PULL_D, 0, _fp2, _fq2);
      if (!f.arc) f.arc = 70 + Math.min(240, f.p0.distanceTo(_fp2) * 0.16);
      _fc.copy(f.p0).add(_fp2).multiplyScalar(0.5);
      _fc.y += f.arc;
      _fc.z += 90;
      bezier(f.p0, _fc, _fp2, u, it.wc);
      it.wq.copy(f.q0).slerp(_fq2, u);
    } else {
      // slides into the slot, straightening; at the end it is exactly the slot's pose
      const u = easeOut((t - s1) / (1 - s1));
      this.pulledPose(it, _fp, _fq, PULL_D * (1 - u), PULL_TIP * 0.35 * Math.sin(Math.PI * u), it.wc, it.wq);
      if (t >= 1) {
        this.arrive(it, "shelf");
        return;
      }
    }
    this.renderFromWorldCentre(it, it.wc, it.wq);
  }
  toDesk(id: string, opts: { fast?: boolean; delay?: number; reduced: boolean }) {
    let it: GroundItem | null = this.items.get(id) ?? null;
    const delay = opts.delay ?? 0;
    if (!it) {
      it = this.item(id);
      if (!it) return;
      it.origin = "shelf";
      this.items.set(id, it);
      // (from where the shelf shows it: lifted and slid out a little by the hover, if it is;
      // its cover baked, painted and uploaded before anything moves, so the turn never shows a blank face)
      const v = this.engine.nearestV(id);
      const lift = v === null ? 0 : this.engine.liftOf(v);
      this.prepareCover(id);
      this.engine.hide(id);
      if (this.slotWorld(id, it.wc, it.wq, lift)) this.renderFromWorldCentre(it, it.wc, it.wq);
      const pull = opts.fast ? FAST_MS * (PULL_MS / (PULL_MS + ARC_MS + LAND_MS)) : PULL_MS;
      if (opts.reduced) {
        this.arrive(it, "desk");
        return;
      }
      this.startFlight(it, "desk", { dur: opts.fast ? FAST_MS : PULL_MS + ARC_MS + LAND_MS, pull, delay, lift });
      return;
    }
    if (it.state === "desk") return;
    if (it.state === "flight") {
      if (it.flight!.to === "desk") return;
      // called back mid-return: up again from where it is (it is already out of its slot)
      if (opts.reduced) {
        this.arrive(it, "desk");
        return;
      }
      this.startFlight(it, "desk", { dur: opts.fast ? FAST_MS * 0.7 : ARC_MS + LAND_MS, pull: 0, delay });
      return;
    }
    if (it.state === "return") {
      // opened while flying back to its slot (it belongs to the row now, and its slot is held
      // for it): on to the desk from where it is, and back to that slot afterwards
      it.ret = null;
      it.origin = "shelf";
      this.grounded.delete(it.id);
      this.engine.hide(it.id);
      if (opts.reduced) {
        this.arrive(it, "desk");
        return;
      }
      this.startFlight(it, "desk", { dur: opts.fast ? FAST_MS * 0.7 : ARC_MS + LAND_MS, pull: 0, delay });
    }
    // (a falling book is nobody's to open)
  }
  fromDesk(id: string, opts: { fast?: boolean; reduced: boolean }) {
    const it = this.items.get(id);
    if (!it || (it.state !== "desk" && it.state !== "flight")) return;
    if (it.state === "flight" && it.flight!.to !== "desk") return; // already on its way back
    if (opts.reduced) {
      this.arrive(it, "shelf");
      return;
    }
    this.startFlight(it, "shelf", { dur: opts.fast ? SHELVE_FAST_MS : SHELVE_MS, pull: 0, delay: 0 });
  }
  /** debug / tests: where the last book shelved from the desk ended against its slot (world units, stage px) */
  lastShelved: { id: string; d: number; px: number } | null = null;
  /** debug / tests: every book flying or on the desk */
  flights() {
    const out: { id: string; state: State; origin: "shelf" | "ground"; to: string | null; stage: string }[] = [];
    for (const it of this.items.values()) {
      if (it.state !== "flight" && it.state !== "desk") continue;
      out.push({ id: it.id, state: it.state, origin: it.origin, to: it.flight ? it.flight.to : null, stage: this.deskBookOf(it).stage });
    }
    return out;
  }
  /** The desk's book, for the shadow under it and for tests: its pose, size and the shadow's strength. */
  deskBook(): { id: string; state: State; stage: string; pos: THREE.Vector3; quat: THREE.Quaternion; w: number; h: number; alpha: number } | null {
    // (the one on the desk or on its way there comes first: another may still be flying back)
    let best: GroundItem | null = null;
    for (const it of this.items.values()) {
      if (it.state !== "desk" && it.state !== "flight") continue;
      const toDesk = it.state === "desk" || it.flight?.to === "desk";
      if (!best || toDesk) best = it;
      if (toDesk) break;
    }
    return best ? this.deskBookOf(best) : null;
  }
  private deskBookOf(it: GroundItem) {
    const L = layout(it.e);
    const f = it.flight;
    let stage = "desk";
    if (f) {
      const e = performance.now() - f.t0;
      if (f.to !== "desk") stage = f.to;
      else if (e < 0) stage = "wait";
      else if (e < f.pull) stage = "pull";
      else if (e < f.dur - f.dur * (LAND_MS / (PULL_MS + ARC_MS + LAND_MS))) stage = "arc";
      else stage = "land";
    }
    return { id: it.id, state: it.state, stage, pos: it.wc, quat: it.wq, w: L.D, h: L.h, alpha: it.deskAlpha };
  }

  // ------------------------------------------------------------- world

  /** The world poses of every part (plus fan leaves for an open book). */
  private updateWorld(it: GroundItem) {
    const parts = it.parts;
    const out = it.render;
    if (!parts.length) {
      out.length = 0;
      return;
    }
    let n = 0;
    const put = (kind: PartKind, half: THREE.Vector3, p: THREE.Vector3, q: THREE.Quaternion) => {
      let rp = out[n];
      if (!rp) rp = out[n] = { kind, half: half.clone(), pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      rp.kind = kind;
      rp.half.copy(half);
      this.toWorld(p, q, rp.pos, rp.quat);
      n++;
    };
    for (const pt of parts) put(pt.kind, pt.half, pt.pos, pt.quat);
    if (parts.length > 1) this.fanLeaves(it, (half, p, q) => put("fan", half, p, q));
    out.length = n;
    this.centreOf(it, _v, _q);
    this.toWorld(_v, _q, it.wc, _q2);
  }
  /** A flying book: parts from the book's world centre pose (frozen relative poses). */
  private renderFromWorldCentre(it: GroundItem, wc: THREE.Vector3, wq: THREE.Quaternion) {
    const out = it.render;
    let n = 0;
    const basePos = _v.copy(it.cOff).applyQuaternion(wq).negate().add(wc);
    for (const pt of it.parts) {
      let rp = out[n];
      if (!rp) rp = out[n] = { kind: pt.kind, half: pt.half.clone(), pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      rp.kind = pt.kind;
      rp.half.copy(pt.half);
      rp.pos.copy(pt.rel.p).applyQuaternion(wq).add(basePos);
      rp.quat.copy(wq).multiply(pt.rel.q);
      n++;
    }
    out.length = n;
  }
  /** debug: the fan a book would draw now (its page and cover openings, the fan's far angle, leaves drawn) */
  fanInfo(it: GroundItem): { a0: number; cover: number; a1: number; n: number } | null {
    if (it.parts.length < 3) return null;
    const a0 = openingOf(it.parts[1].rel);
    const cover = openingOf(it.parts[2].rel);
    const a1 = Math.min(cover, a0 + 0.75);
    const n = a1 - a0 < 0.15 || a1 < 0.3 ? 0 : FAN_PARTS;
    return { a0, cover, a1, n };
  }
  /** Thin leaves fanned between the page group and the cover of a tumbling book (row space). */
  private fanLeaves(it: GroundItem, put: (half: THREE.Vector3, p: THREE.Vector3, q: THREE.Quaternion) => void) {
    const pages = it.parts[1];
    const cover = it.parts[2];
    const a0 = openingOf(pages.rel);
    // (a tumbling book's cover may fly wide open: its leaves stay within a modest fan)
    const a1 = Math.min(openingOf(cover.rel), a0 + 0.75);
    if (a1 - a0 < 0.15 || a1 < 0.3) return;
    const L = layout(it.e);
    const b = it.parts[0];
    const half = _v2.set(0.6, L.h / 2, L.D / 2);
    for (let k = 1; k <= FAN_PARTS; k++) {
      const a = a0 + ((a1 - a0) * k) / (FAN_PARTS + 1);
      const rel = openedRel(L.pagesX + L.tp / 2 + 0.5, L.baseX, L.D, a);
      _v.copy(rel.p).applyQuaternion(b.quat).add(b.pos);
      _q.copy(b.quat).multiply(rel.q);
      put(half, _v, _q);
    }
  }
  /** A flight cut short: the row-space pose from the world one. */
  private rowPoseFromWorld(it: GroundItem) {
    const o = { x: 0, z: 0 };
    this.toRow(it.wc.x, it.wc.z, o);
    const s = this.sOf(o.x);
    const a = this.engine.drum.at(s, { x: 0, z: 0, phi: 0 });
    _q.setFromAxisAngle(Y_AXIS, -a.phi);
    this.setParts(it, "whole", 0, 0);
    this.setCentre(it, new THREE.Vector3(o.x, it.wc.y, Math.max(Z_BACK + 60, Math.min(Z_FRONT - 60, o.z))), _q);
  }

  /** Debug: the opening angle of each book's cover (degrees), by state. */
  openings() {
    const out: { id: string; state: State; kind: Kind; hinged: boolean; body: boolean; cover: number; pages: number; y: number }[] = [];
    for (const it of this.items.values()) {
      const split = it.parts.length > 1;
      out.push({
        id: it.id,
        state: it.state,
        kind: it.kind,
        hinged: it.hinged,
        body: it.traj !== null,
        cover: split ? Math.round((openingOf(it.parts[2].rel) * 180) / Math.PI) : 0,
        pages: split ? Math.round((openingOf(it.parts[1].rel) * 180) / Math.PI) : 0,
        y: Math.round(it.parts[0].pos.y),
      });
    }
    return out;
  }

  dispose() {
    for (const j of this.jobs.values()) window.clearTimeout(j.timer);
    this.jobs.clear();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
  }
}
