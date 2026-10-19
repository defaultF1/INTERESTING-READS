/**
 * The drum: books stand along a convex arc whose turn eases from flat in the
 * middle to ±24° at the viewport edges (pow 1.35). It's a real 3D curve, so
 * the curvature is true perspective; gentle enough that edge books stay
 * readable.
 *
 * Coordinates: x right, y up, z toward the camera, in world units (a book's
 * own px; the camera scales them by view.k). s is arc length from the
 * viewport centre. `halfW` and screen x here are in world units too. A book at s
 * stands at (x(s), 0, z(s)) turned by phi(s) (its spine normal is
 * (sin phi, 0, cos phi)).
 */

// The perspective distance. The guide's was 1400; it is further back (with the same framing: the
// view scale comes from the stage) so books on the floor, a book's height nearer the eye, stay
// within ~10% of the size of the ones on the shelf.
export const CAM_D = 2400;
const PHI_MAX = (24 * Math.PI) / 180;
const CURVE_POW = 1.35;
const STEP = 2;

export class Drum {
  halfW = 0;
  sMax = 1;
  sLim = 1;
  private X = new Float32Array(0);
  private Z = new Float32Array(0);
  private PHI = new Float32Array(0);
  private SX = new Float32Array(0);
  private n = 0;

  constructor(halfW: number) {
    this.build(halfW);
  }

  private phiOf(s: number, sMax: number) {
    const t = Math.min(1, Math.abs(s) / sMax);
    return Math.sign(s) * PHI_MAX * Math.pow(t, CURVE_POW);
  }

  /** Screen x (px from the centre) of arc position s, by direct integration. */
  private screenXFor(s: number, sMax: number) {
    let x = 0;
    let z = 0;
    const steps = Math.max(1, Math.ceil(Math.abs(s) / STEP));
    const ds = s / steps;
    for (let i = 0; i < steps; i++) {
      const p = this.phiOf((i + 0.5) * ds, sMax);
      x += Math.cos(p) * ds;
      z -= Math.sin(p) * ds;
    }
    return (x * CAM_D) / (CAM_D - z);
  }

  build(halfW: number) {
    this.halfW = Math.max(160, halfW);
    // sMax: the arc length that lands exactly on the viewport edge
    let lo = this.halfW * 0.6;
    let hi = this.halfW * 3;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.screenXFor(mid, mid) < this.halfW) lo = mid;
      else hi = mid;
    }
    this.sMax = (lo + hi) / 2;
    this.sLim = this.sMax + Math.max(400, this.halfW * 0.6);
    const n = Math.ceil((2 * this.sLim) / STEP) + 1;
    this.n = n;
    this.X = new Float32Array(n);
    this.Z = new Float32Array(n);
    this.PHI = new Float32Array(n);
    this.SX = new Float32Array(n);
    const mid = Math.round(this.sLim / STEP);
    // integrate outward from the centre in both directions
    for (const dir of [1, -1]) {
      let x = 0;
      let z = 0;
      for (let i = 0; ; i++) {
        const idx = mid + dir * i;
        if (idx < 0 || idx >= n) break;
        const s = dir * i * STEP;
        const p = this.phiOf(s, this.sMax);
        this.X[idx] = x;
        this.Z[idx] = z;
        this.PHI[idx] = p;
        this.SX[idx] = (x * CAM_D) / (CAM_D - z);
        const pm = this.phiOf(s + (dir * STEP) / 2, this.sMax);
        x += Math.cos(pm) * dir * STEP;
        z -= Math.sin(pm) * dir * STEP;
      }
    }
  }

  /** Pose at arc position s (linear interpolation; straight beyond the table). */
  at(s: number, out: { x: number; z: number; phi: number }) {
    const f = (s + this.sLim) / STEP;
    if (f <= 0 || f >= this.n - 1) {
      const edge = f <= 0 ? 0 : this.n - 1;
      const se = edge * STEP - this.sLim;
      const p = this.PHI[edge];
      const ds = s - se;
      out.x = this.X[edge] + Math.cos(p) * ds;
      out.z = this.Z[edge] - Math.sin(p) * ds;
      out.phi = p;
      return out;
    }
    const i = Math.floor(f);
    const t = f - i;
    out.x = this.X[i] + (this.X[i + 1] - this.X[i]) * t;
    out.z = this.Z[i] + (this.Z[i + 1] - this.Z[i]) * t;
    out.phi = this.PHI[i] + (this.PHI[i + 1] - this.PHI[i]) * t;
    return out;
  }

  /** Arc position whose drum point has world x (X grows with s). */
  sAtX(x: number): number {
    const X = this.X;
    if (x <= X[0]) return -this.sLim;
    if (x >= X[this.n - 1]) return this.sLim;
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (X[m] < x) lo = m;
      else hi = m;
    }
    const t = (x - X[lo]) / Math.max(1e-6, X[hi] - X[lo]);
    return lo * STEP - this.sLim + t * STEP;
  }

  /** Arc position whose spine front sits at screen x (px from the centre). */
  sAtScreen(px: number): number {
    const SX = this.SX;
    if (px <= SX[0]) return -this.sLim;
    if (px >= SX[this.n - 1]) return this.sLim;
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (SX[m] < px) lo = m;
      else hi = m;
    }
    const t = (px - SX[lo]) / Math.max(1e-6, SX[hi] - SX[lo]);
    return lo * STEP - this.sLim + t * STEP;
  }
}
