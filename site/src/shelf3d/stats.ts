/**
 * Frame statistics for the WebGL shelf (exposed on `window.__shelf` with
 * ?debug, and used by the adaptive quality tiers). Intervals are measured
 * between consecutive rendered frames only (an idle shelf renders nothing).
 */
const N = 2400;

type FrameSummary = {
  n: number;
  fps: number;
  median: number;
  p95: number;
  std: number;
  /** frames slower than 1.5× the median */
  judder: number;
  /** main-thread ms per frame spent in the shelf (engine + instance writes + render submit) */
  cpuMedian: number;
  cpuP95: number;
};

export class FrameStats {
  private iv = new Float32Array(N);
  private cpu = new Float32Array(N);
  private n = 0;
  private lastTs = 0;
  frames = 0;
  blankFrames = 0;

  /** Interval samples recorded so far. */
  get count() {
    return this.n;
  }

  /** A rendered frame at rAF time `ts` that took `cpuMs` on the main thread. */
  record(ts: number, cpuMs: number, blank: number) {
    this.frames++;
    if (blank > 0) this.blankFrames++;
    const dt = this.lastTs ? ts - this.lastTs : 0;
    this.lastTs = ts;
    // only consecutive frames count (a gap > 250ms is the shelf going idle)
    if (dt <= 0 || dt > 250) return;
    const i = this.n % N;
    this.iv[i] = dt;
    this.cpu[i] = cpuMs;
    this.n++;
  }
  /** The loop went idle: the next frame starts a new run. */
  idle() {
    this.lastTs = 0;
  }
  reset() {
    this.n = 0;
    this.lastTs = 0;
    this.frames = 0;
    this.blankFrames = 0;
  }
  /** Interval samples from the last `last` frames (all by default). */
  intervals(last = N): number[] {
    const k = Math.min(this.n, N, last);
    const out: number[] = [];
    for (let j = this.n - k; j < this.n; j++) out.push(this.iv[j % N]);
    return out;
  }
  summary(last = N): FrameSummary {
    const k = Math.min(this.n, N, last);
    const iv: number[] = [];
    const cpu: number[] = [];
    for (let j = this.n - k; j < this.n; j++) {
      iv.push(this.iv[j % N]);
      cpu.push(this.cpu[j % N]);
    }
    if (!k) return { n: 0, fps: 0, median: 0, p95: 0, std: 0, judder: 0, cpuMedian: 0, cpuP95: 0 };
    const q = (arr: number[], p: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };
    const mean = iv.reduce((a, b) => a + b, 0) / k;
    const median = q(iv, 0.5);
    const std = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / k);
    return {
      n: k,
      fps: 1000 / mean,
      median,
      p95: q(iv, 0.95),
      std,
      judder: iv.filter((x) => x > median * 1.5).length,
      cpuMedian: q(cpu, 0.5),
      cpuP95: q(cpu, 0.95),
    };
  }
}
