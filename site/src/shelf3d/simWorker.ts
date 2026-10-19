/// <reference lib="webworker" />
import { createFloorPhysics, type FloorSpec, type HingeSpec, type PartSpec, type V3 } from "./physics";

/**
 * The burst simulation: a whole fall (or one thrown book) is simulated here at once, at
 * 120 Hz, with hinged covers, and every recorded frame goes back to the page, which plays it
 * back. Tens of milliseconds of work, off the main thread. Deterministic for a given job.
 */

/**
 * A faller: pushed (kinematic) forward by `push.dz` over `push.steps`, tipped (kinematic) about
 * the plank's front edge to `tip.deg` over `tip.steps`, then handed to the solver with the
 * tip's own swing (its pitch rate `angvel.x` about the edge) plus `linvel` (a hold-back).
 */
export type SimFaller = {
  parts: PartSpec[];
  hinges: HingeSpec[] | null;
  linvel: V3;
  angvel: V3;
  start: number;
  push: { dz: number; steps: number } | null;
  tip: { deg: number; steps: number; pivotZ: number; yaw?: number } | null;
  /** continuous collision for a one-box faller (hinged ones cannot: thin jointed parts blow up) */
  ccd?: boolean;
  /** how much of the tip's forward swing is cancelled at hand-off (1 = all: it drops straight down, turning) */
  hold: number;
};
export type SimJob = {
  id: number;
  spec: FloorSpec;
  fixed: PartSpec[];
  fallers: SimFaller[];
  steps: number;
  /** record every n-th step */
  every: number;
  /** a faller slower than this (mm/s, rad/s) for 0.25 s has come to rest and is frozen */
  restV: number;
  restW: number;
};
export type SimResult = {
  id: number;
  frames: number;
  every: number;
  hz: number;
  /** parts per faller */
  parts: number[];
  /** frames x sum(parts) x 7 (px py pz qx qy qz qw), in mm */
  samples: Float32Array;
  /** the step at which each faller came to rest (-1: never) */
  rest: number[];
  /** the deepest penetration (mm) of each faller at the end */
  penetration: number[];
  /** still up at plank height at the end */
  stuck: boolean[];
  ms: number;
};
/**
 * The frames as they are simulated, a few at a time, ahead of the result: the page starts the
 * playback on the first (the solver runs several times faster than real time, so the playback
 * never catches up with it), and nothing waits for the whole fall to be simulated.
 */
export type SimChunk = {
  id: number;
  /** frames k0 .. k1-1 */
  k0: number;
  k1: number;
  chunk: Float32Array;
  frames: number;
  every: number;
  hz: number;
  parts: number[];
};
/** frames per chunk (every 2nd step: 10 frames = 0.2 s of the fall) */
const CHUNK_FRAMES = 10;

const P = { x: 0, y: 0, z: 0 };
const Q = { x: 0, y: 0, z: 0, w: 1 };
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t;
type Q4 = { x: number; y: number; z: number; w: number };
const qmul = (a: Q4, b: Q4): Q4 => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
/** The faller's parts at sim step s before it is handed to the solver (standing, pushed, tipping). */
function staged(f: SimFaller, s: number): PartSpec[] {
  const pushSteps = f.push?.steps ?? 0;
  const tipSteps = f.tip?.steps ?? 0;
  const u = s - f.start;
  const dz = f.push ? f.push.dz * easeOut(Math.max(0, Math.min(1, u / Math.max(1, pushSteps)))) : 0;
  const a = f.tip && u > pushSteps ? ((f.tip.deg * Math.PI) / 180) * easeIn(Math.max(0, Math.min(1, (u - pushSteps) / Math.max(1, tipSteps)))) : 0;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pivotZ = f.tip?.pivotZ ?? 0;
  const k = f.tip && f.tip.deg ? a / ((f.tip.deg * Math.PI) / 180) : 0;
  const yaw = (f.tip?.yaw ?? 0) * k;
  const qx = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
  const qy = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const q = qmul(qy, qx);
  const cx = f.parts[0] ? f.parts[0].pos.x : 0;
  return f.parts.map((p) => {
    const z0 = p.pos.z + dz - pivotZ;
    const y0 = p.pos.y;
    const ty = y0 * ca - z0 * sa;
    const tz = pivotZ + y0 * sa + z0 * ca;
    const rx = p.pos.x - cx;
    const rz = tz - pivotZ;
    return { half: p.half, pos: { x: cx + rx * Math.cos(yaw) + rz * Math.sin(yaw), y: ty, z: pivotZ - rx * Math.sin(yaw) + rz * Math.cos(yaw) }, quat: a ? qmul(q, p.quat) : p.quat };
  });
}

async function run(job: SimJob, post: (chunk: SimChunk) => void): Promise<SimResult> {
  const t0 = performance.now();
  const hz = job.spec.hz ?? 120;
  const phys = await createFloorPhysics({ ...job.spec, hz });
  phys.addStatic(job.fixed);
  const n = job.fallers.length;
  const parts = job.fallers.map((f) => f.parts.length);
  const stride = parts.reduce((a, b) => a + b, 0) * 7;
  const frames = Math.floor(job.steps / job.every) + 1;
  const samples = new Float32Array(frames * stride);
  let sent = 0;
  const flush = (upTo: number) => {
    if (upTo <= sent) return;
    post({ id: job.id, k0: sent, k1: upTo, chunk: samples.slice(sent * stride, upTo * stride), frames, every: job.every, hz, parts });
    sent = upTo;
  };
  const rest = new Array<number>(n).fill(-1);
  const quiet = new Array<number>(n).fill(0);
  const alive = new Array<boolean>(n).fill(false);
  const relaxed = new Array<boolean>(n).fill(false);
  const quietSteps = Math.round(hz * 0.25);
  const record = (frame: number, s: number) => {
    let o = frame * stride;
    job.fallers.forEach((f, i) => {
      const stagedParts = alive[i] ? null : staged(f, s);
      for (let p = 0; p < f.parts.length; p++) {
        if (alive[i]) phys.readNow(i + 1, p, P, Q);
        else {
          const pt = stagedParts![p];
          P.x = pt.pos.x;
          P.y = pt.pos.y;
          P.z = pt.pos.z;
          Q.x = pt.quat.x;
          Q.y = pt.quat.y;
          Q.z = pt.quat.z;
          Q.w = pt.quat.w;
        }
        samples[o++] = P.x;
        samples[o++] = P.y;
        samples[o++] = P.z;
        samples[o++] = Q.x;
        samples[o++] = Q.y;
        samples[o++] = Q.z;
        samples[o++] = Q.w;
      }
    });
  };
  record(0, 0);
  for (let s = 1; s <= job.steps; s++) {
    job.fallers.forEach((f, i) => {
      const handOff = f.start + (f.push?.steps ?? 0) + (f.tip?.steps ?? 0);
      if (alive[i] || handOff > s) return;
      alive[i] = true;
      const key = i + 1;
      const parts = staged(f, handOff);
      // the swing: the centre's velocity from the pitch rate about the plank's edge, plus the hold-back
      const c = parts[0].pos;
      const pivotZ = f.tip?.pivotZ ?? c.z;
      const w = f.tip ? f.angvel.x : 0;
      const linvel = { x: f.linvel.x, y: -w * (c.z - pivotZ) + f.linvel.y, z: w * c.y * (1 - f.hold) + f.linvel.z };
      if (!f.hinges || !phys.addHinged(key, parts, f.hinges, { linvel, angvel: f.angvel })) {
        phys.addRigid(key, parts, { linvel, angvel: f.angvel, ccd: !!f.ccd });
      }
    });
    phys.stepOnce();
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      // at rest = its block still for a quarter second and not moving again; a landed book's
      // bindings stop springing, so its boards settle against whatever they touch
      const m = phys.baseMotion(i + 1);
      if (m.v < job.restV && m.w < job.restW) {
        quiet[i]++;
        if (quiet[i] === quietSteps) {
          rest[i] = s - quietSteps;
          if (!relaxed[i]) {
            relaxed[i] = true;
            phys.relaxJoints(i + 1);
          }
        }
      } else if (m.v > job.restV * 1.6 || m.w > job.restW * 1.6) {
        // moving again for real (a creep below that stays "at rest")
        quiet[i] = 0;
        rest[i] = -1;
      }
    }
    if (s % job.every === 0) {
      const frame = s / job.every;
      record(frame, s);
      if ((frame + 1) % CHUNK_FRAMES === 0) flush(frame + 1);
    }
  }
  flush(frames);
  const penetration = job.fallers.map((_, i) => (alive[i] ? phys.penetration(i + 1) : 0));
  const stuck = job.fallers.map((_, i) => {
    if (!alive[i]) return true;
    phys.readNow(i + 1, 0, P, Q);
    return P.y > -job.spec.lip - 40;
  });
  phys.dispose();
  return { id: job.id, frames, every: job.every, hz, parts, samples, rest, penetration, stuck, ms: performance.now() - t0 };
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<SimJob | { id: number; warm: true }>) => {
  const msg = ev.data;
  chain = chain
    .then(async () => {
      if ("warm" in msg) {
        // load the solver ahead of the first fall
        const phys = await createFloorPhysics({ floorY: -500, xMin: -1e4, xMax: 1e4, zBack: -200, zFront: 307, plankBack: -204, plankFront: 40, lip: 18, hz: 120 });
        phys.dispose();
        (self as unknown as Worker).postMessage({ id: msg.id, warm: true });
        return;
      }
      const res = await run(msg, (chunk) => (self as unknown as Worker).postMessage(chunk, [chunk.chunk.buffer]));
      (self as unknown as Worker).postMessage(res, [res.samples.buffer]);
    })
    .catch((e) => {
      (self as unknown as Worker).postMessage({ id: msg.id, error: String(e) });
    });
};
