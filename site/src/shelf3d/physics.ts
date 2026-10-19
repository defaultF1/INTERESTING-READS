import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Rapier for the falls (its own lazy chunk, prefetched at idle once the shelf
 * is up, run in a worker). The simulation runs in SHELF-ROW space: x along the
 * shelf (row units), y up from the plank's top, z toward the viewer; the
 * renderer maps that onto the drum. Units are millimetres (a book ~30 × 220 ×
 * 178), the solver works in metres. A fixed step, driven by the burst.
 *
 * A falling book is a hinged compound: a base (back cover + most pages), a
 * page group and the front cover, on two revolute joints with a per-binding
 * spring (hardcovers close, paperbacks flop). The ground lies far below
 * anything the stage shows: a fall ends at the stage's bottom edge, nothing lands.
 */

export type V3 = { x: number; y: number; z: number };
export type Q4 = { x: number; y: number; z: number; w: number };
export type FloorSpec = {
  /** fixed steps per second (60 for the live world, 120 for a burst simulation) */
  hz?: number;
  floorY: number;
  xMin: number;
  xMax: number;
  zBack: number;
  zFront: number;
  plankBack: number;
  plankFront: number;
  lip: number;
};
/** A rigid part: half extents and its absolute pose (row space, mm). */
export type PartSpec = { half: V3; pos: V3; quat: Q4 };
export type HingeSpec = {
  /** index of the moving part (its parent is part 0) */
  child: number;
  anchorParent: V3;
  anchorChild: V3;
  /** opening range about +y, radians: [min, max] */
  min: number;
  max: number;
  /** the binding's rest angle (0 closed, negative = open) and its spring */
  rest: number;
  stiffness: number;
  damping: number;
};
export type Rel = { p: V3; q: Q4 };

const M = 0.001; // mm -> m
/** full gravity: the drop is short and quick, the way a real book falls */
export const GRAVITY_SCALE = 1;
const MAX_STEPS = 4;
const DENSITY = 650;
/** books are ~0.2 m and their boards ~1.5 mm: the solver's tolerances (allowed penetration, prediction, sleep) scale with this */
const LENGTH_UNIT = 0.1;

type Slot = { body: RAPIER.RigidBody; ud: number; half: V3; prevP: V3; prevQ: Q4; curP: V3; curQ: Q4 };
type Entry = { slots: Slot[]; joints: RAPIER.ImpulseJoint[]; rel: Rel[] };

const qmul = (a: Q4, b: Q4): Q4 => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qconj = (q: Q4): Q4 => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qrot = (q: Q4, v: V3): V3 => {
  const r = qmul(qmul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), qconj(q));
  return { x: r.x, y: r.y, z: r.z };
};
const fin = (o: object | undefined) => !o || Object.values(o).every((x) => typeof x !== "number" || Number.isFinite(x));

export class FloorPhysics {
  private world: RAPIER.World;
  private entries = new Map<number, Entry>();
  private awake = new Set<number>(); // body userData values awake after the last step
  private acc = 0;
  private spec: FloorSpec;
  /** ms spent in world.step() during the last frame, and the most in one fixed step since reset (debug) */
  lastStepMs = 0;
  maxStepMs = 0;

  readonly step_s: number;

  constructor(spec: FloorSpec) {
    this.spec = spec;
    this.step_s = 1 / (spec.hz ?? 60);
    this.world = new RAPIER.World({ x: 0, y: -9.81 * GRAVITY_SCALE, z: 0 });
    this.world.timestep = this.step_s;
    this.world.integrationParameters.lengthUnit = LENGTH_UNIT;
    // contacts are predicted this far ahead (x lengthUnit = 40 mm): a book hitting the floor at
    // 3-4 m/s moves ~30 mm a step, and a thin board must never end up past a surface's middle
    this.world.integrationParameters.normalizedPredictionDistance = 0.4;
    // a burst (100 Hz, off the main thread) can afford more solver iterations and stiffer
    // contacts: piles settle without sinking into one another (the slack under a pile's weight
    // was 5-10 mm at the default 30 Hz contact stiffness)
    this.world.integrationParameters.numSolverIterations = (spec.hz ?? 60) >= 100 ? 8 : 4;
    this.world.integrationParameters.contact_natural_frequency = (spec.hz ?? 60) >= 100 ? 80 : 30;
    const fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number, friction: number, slick = false) => {
      const d = RAPIER.ColliderDesc.cuboid(hx * M, hy * M, hz * M)
        .setTranslation(x * M, y * M, z * M)
        .setFriction(friction)
        .setRestitution(0.12);
      if (slick) d.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      this.world.createCollider(d, fixed);
    };
    const { floorY, xMin, xMax, zBack, zFront } = spec;
    const T = 200;
    const wallH = (-spec.lip - 10 - floorY) / 2;
    const cx = (xMin + xMax) / 2;
    const hx = (xMax - xMin) / 2 + T;
    const cz = (zBack + zFront) / 2;
    const hz = (zFront - zBack) / 2 + T;
    // the floor (top at floorY), reaching well past the band's front so a book that gets
    // past the kerb still lands (and a validation can see it lying in front of the band)
    box(hx, T, hz + 1500, cx, floorY - T, cz + 1500, 0.8);
    box(T, 1500, hz, xMin - T, floorY + 1500, cz, 0.6); // side walls
    box(T, 1500, hz, xMax + T, floorY + 1500, cz, 0.6);
    // the wall behind the floor band, under the plank only (the books start above it, on the plank)
    box(hx, wallH, T, cx, floorY + wallH, zBack - T, 0.6);
    // the front of the band: a thin kerb, a book's thickness or three high (a book sliding or
    // bouncing out along the floor stops at it; a tumbling one, higher up, passes over it)
    box(hx, 30, 10, cx, floorY + 30, zFront + 10, 0.6);
    // the plank, waxed: a book slides off it and tips over the front edge (thick underneath so
    // nothing thrown up at it passes through)
    const depth = spec.plankFront - spec.plankBack;
    const plankH = (spec.lip + 80) / 2;
    box(hx, plankH, depth / 2, cx, -plankH, (spec.plankFront + spec.plankBack) / 2, 0.06, true);
  }

  /** The first step ever is slow (one-time WASM warm-up): pay it now, at idle. */
  warmup() {
    this.addRigid(-1, [{ half: { x: 15, y: 110, z: 89 }, pos: { x: 0, y: this.spec.floorY + 200, z: 150 }, quat: { x: 0, y: 0, z: 0, w: 1 } }], {});
    for (let i = 0; i < 3; i++) this.world.step();
    this.remove(-1);
    this.world.step();
    this.maxStepMs = 0;
  }

  private slot(body: RAPIER.RigidBody, ud: number, half: V3, p: V3, q: Q4): Slot {
    body.userData = ud;
    const P = { x: p.x, y: p.y, z: p.z };
    const Q = { x: q.x, y: q.y, z: q.z, w: q.w };
    return { body, ud, half, prevP: { ...P }, prevQ: { ...Q }, curP: P, curQ: Q };
  }
  private bodyDesc(p: V3, q: Q4, kinematic: boolean) {
    return (kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(p.x * M, p.y * M, p.z * M)
      .setRotation(q)
      .setLinearDamping(0.08)
      .setAngularDamping(0.6);
    // no CCD: with hinged thin parts it blows up (and every fixed shape here is thick enough)
  }
  private collider(half: V3, rel?: Rel, group = -1) {
    const d = RAPIER.ColliderDesc.cuboid(half.x * M, half.y * M, half.z * M).setDensity(DENSITY).setFriction(0.7).setRestitution(0.12);
    if (rel) d.setTranslation(rel.p.x * M, rel.p.y * M, rel.p.z * M).setRotation(rel.q);
    void group;
    return d;
  }

  /**
   * One rigid body made of `parts` (part 0's pose is the body's; the others
   * become colliders at their relative poses). Returns false for a bad pose.
   */
  addRigid(key: number, parts: PartSpec[], opts: { linvel?: V3; angvel?: V3; sleeping?: boolean; kinematic?: boolean; ccd?: boolean }) {
    this.remove(key);
    if (!parts.length || parts.some((p) => !fin(p.pos) || !fin(p.quat) || !fin(p.half)) || !fin(opts.linvel) || !fin(opts.angvel)) return false;
    const base = parts[0];
    const desc = this.bodyDesc(base.pos, base.quat, !!opts.kinematic);
    if (opts.ccd) desc.setCcdEnabled(true);
    if (opts.linvel) desc.setLinvel(opts.linvel.x * M, opts.linvel.y * M, opts.linvel.z * M);
    if (opts.angvel) desc.setAngvel(opts.angvel);
    if (opts.sleeping) desc.setSleeping(true);
    const body = this.world.createRigidBody(desc);
    const inv = qconj(base.quat);
    const rel: Rel[] = parts.map((pt) => ({
      p: qrot(inv, { x: pt.pos.x - base.pos.x, y: pt.pos.y - base.pos.y, z: pt.pos.z - base.pos.z }),
      q: qmul(inv, pt.quat),
    }));
    parts.forEach((pt, i) => this.world.createCollider(this.collider(pt.half, i ? rel[i] : undefined), body));
    const ud = key * 8;
    this.entries.set(key, { slots: [this.slot(body, ud, base.half, base.pos, base.quat)], joints: [], rel });
    if (!opts.sleeping) this.awake.add(ud);
    return true;
  }

  /** A hinged book: separate bodies for the parts, joined by revolute hinges to part 0. */
  addHinged(key: number, parts: PartSpec[], hinges: HingeSpec[], opts: { linvel?: V3; angvel?: V3 }) {
    this.remove(key);
    if (parts.some((p) => !fin(p.pos) || !fin(p.quat)) || !fin(opts.linvel) || !fin(opts.angvel)) return false;
    const slots: Slot[] = [];
    parts.forEach((pt, i) => {
      const desc = this.bodyDesc(pt.pos, pt.quat, false);
      if (opts.linvel) desc.setLinvel(opts.linvel.x * M, opts.linvel.y * M, opts.linvel.z * M);
      if (opts.angvel) desc.setAngvel(opts.angvel);
      const body = this.world.createRigidBody(desc);
      this.world.createCollider(this.collider(pt.half), body);
      const ud = key * 8 + i;
      slots.push(this.slot(body, ud, pt.half, pt.pos, pt.quat));
      this.awake.add(ud);
    });
    const joints: RAPIER.ImpulseJoint[] = [];
    for (const h of hinges) {
      const data = RAPIER.JointData.revolute(
        { x: h.anchorParent.x * M, y: h.anchorParent.y * M, z: h.anchorParent.z * M },
        { x: h.anchorChild.x * M, y: h.anchorChild.y * M, z: h.anchorChild.z * M },
        { x: 0, y: 1, z: 0 },
      );
      const j = this.world.createImpulseJoint(data, slots[0].body, slots[h.child].body, true) as RAPIER.RevoluteImpulseJoint;
      j.setContactsEnabled(false);
      j.setLimits(h.min, h.max);
      j.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
      j.configureMotorPosition(h.rest, h.stiffness, h.damping);
      joints.push(j);
    }
    // the hinged parts never collide with one another (the page group and the cover are not
    // jointed to each other: a slack spring joint between them only carries that flag)
    if (slots.length === 3) {
      const slack = this.world.createImpulseJoint(RAPIER.JointData.spring(0, 0, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), slots[1].body, slots[2].body, false);
      slack.setContactsEnabled(false);
      joints.push(slack);
    }
    this.entries.set(key, { slots, joints, rel: parts.map(() => ({ p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } })) });
    return true;
  }

  remove(key: number) {
    const en = this.entries.get(key);
    if (!en) return;
    for (const j of en.joints) this.world.removeImpulseJoint(j, false);
    for (const s of en.slots) {
      this.world.removeRigidBody(s.body);
      this.awake.delete(s.ud);
    }
    this.entries.delete(key);
  }

  /** One fixed step (a burst simulation drives these itself). */
  stepOnce() {
    this.acc = this.step_s;
    this.step(0);
  }
  /** Advance by real time; returns true while anything is awake. */
  step(dt: number): boolean {
    const STEP = this.step_s;
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const t0 = performance.now();
    let stepped = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      const s0 = performance.now();
      this.world.step();
      this.maxStepMs = Math.max(this.maxStepMs, performance.now() - s0);
      stepped = true;
      this.world.forEachActiveRigidBody((b) => {
        const ud = b.userData as number;
        const s = this.entries.get(Math.floor(ud / 8))?.slots[ud % 8];
        if (!s || s.ud !== ud) return;
        const t = b.translation();
        const r = b.rotation();
        if (!Number.isFinite(t.x + t.y + t.z + r.x + r.y + r.z + r.w)) return;
        s.prevP = s.curP;
        s.prevQ = s.curQ;
        s.curP = { x: t.x / M, y: t.y / M, z: t.z / M };
        s.curQ = { x: r.x, y: r.y, z: r.z, w: r.w };
      });
    }
    this.lastStepMs = stepped ? performance.now() - t0 : 0;
    // (only after a real step: a body added since the last one is awake until the engine has seen it)
    if (stepped) {
      this.awake.clear();
      this.world.forEachActiveRigidBody((b) => this.awake.add(b.userData as number));
    }
    return this.awake.size > 0;
  }

  /** Was any of this book's bodies awake after the last step? */
  isAwake(key: number) {
    const en = this.entries.get(key);
    if (!en) return false;
    for (const s of en.slots) if (this.awake.has(s.ud)) return true;
    return false;
  }

  /** The current (un-interpolated) pose of part i's body, in mm. */
  readNow(key: number, i: number, outP: V3, outQ: Q4): boolean {
    const s = this.entries.get(key)?.slots[i];
    if (!s) return false;
    const t = s.body.translation();
    const r = s.body.rotation();
    outP.x = t.x / M;
    outP.y = t.y / M;
    outP.z = t.z / M;
    outQ.x = r.x;
    outQ.y = r.y;
    outQ.z = r.z;
    outQ.w = r.w;
    return true;
  }
  /** Fixed boxes (books already lying on the floor) for the fallers to land on. */
  addStatic(parts: PartSpec[]) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const pt of parts) {
      if (!fin(pt.pos) || !fin(pt.quat) || !fin(pt.half)) continue;
      this.world.createCollider(this.collider(pt.half, { p: pt.pos, q: pt.quat }), body);
    }
  }
  /**
   * The deepest penetration (mm, >= 0) between this book's block (its base / whole body, not
   * the thin boards, which may lie a hair inside a neighbour) and anything else right now.
   */
  penetration(key: number): number {
    let worst = 0;
    const s = this.entries.get(key)?.slots[0];
    if (!s) return 0;
    for (let i = 0; i < s.body.numColliders(); i++) {
      const c = s.body.collider(i);
      if (c.halfExtents().x < 3 * M) continue;
      this.world.contactPairsWith(c, (other) => {
        if (other.parent() === s.body || other.halfExtents().x < 3 * M) return;
        this.world.contactPair(c, other, (m) => {
          for (let k = 0; k < m.numContacts(); k++) worst = Math.max(worst, -m.contactDist(k) / M);
        });
      });
    }
    return worst;
  }
  /** Interpolated pose (mm) of part i's body. */
  read(key: number, i: number, outP: V3, outQ: Q4): boolean {
    const s = this.entries.get(key)?.slots[i];
    if (!s) return false;
    const a = this.acc / this.step_s;
    outP.x = s.prevP.x + (s.curP.x - s.prevP.x) * a;
    outP.y = s.prevP.y + (s.curP.y - s.prevP.y) * a;
    outP.z = s.prevP.z + (s.curP.z - s.prevP.z) * a;
    let { x, y, z, w } = s.curQ;
    const p = s.prevQ;
    const sg = p.x * x + p.y * y + p.z * z + p.w * w < 0 ? -1 : 1;
    x = p.x + (x * sg - p.x) * a;
    y = p.y + (y * sg - p.y) * a;
    z = p.z + (z * sg - p.z) * a;
    w = p.w + (w * sg - p.w) * a;
    const n = Math.hypot(x, y, z, w) || 1;
    outQ.x = x / n;
    outQ.y = y / n;
    outQ.z = z / n;
    outQ.w = w / n;
    return true;
  }

  /** Linear velocity of the base (mm/s). */
  velocity(key: number): V3 {
    const s = this.entries.get(key)?.slots[0];
    if (!s) return { x: 0, y: 0, z: 0 };
    const v = s.body.linvel();
    return { x: v.x / M, y: v.y / M, z: v.z / M };
  }
  /** The fastest of the book's bodies: linear (mm/s) and angular (rad/s) speed. */
  motion(key: number): { v: number; w: number } {
    let v = 0;
    let w = 0;
    for (const s of this.entries.get(key)?.slots ?? []) {
      const l = s.body.linvel();
      const a = s.body.angvel();
      v = Math.max(v, Math.hypot(l.x, l.y, l.z) / M);
      w = Math.max(w, Math.hypot(a.x, a.y, a.z));
    }
    return { v, w };
  }
  /** The base body's speed only (mm/s, rad/s): a settled book whose cover still twitches counts as still. */
  baseMotion(key: number): { v: number; w: number } {
    const s = this.entries.get(key)?.slots[0];
    if (!s) return { v: 0, w: 0 };
    const l = s.body.linvel();
    const a = s.body.angvel();
    return { v: Math.hypot(l.x, l.y, l.z) / M, w: Math.hypot(a.x, a.y, a.z) };
  }
  /** A landed hinged book: its bindings stop springing (the boards lie where they came to rest). */
  relaxJoints(key: number) {
    for (const j of this.entries.get(key)?.joints ?? []) {
      const r = j as RAPIER.RevoluteImpulseJoint;
      if (typeof r.configureMotorVelocity === "function") r.configureMotorVelocity(0, 3);
    }
  }
  dispose() {
    this.world.free();
    this.entries.clear();
  }
}

export async function createFloorPhysics(spec: FloorSpec): Promise<FloorPhysics> {
  await RAPIER.init();
  const phys = new FloorPhysics(spec);
  phys.warmup();
  return phys;
}
