import type { Essay } from "../data/essays";

/** Front-cover depth in un-scaled spine space (px). */
export const COVER_W = 178;

/** The camera distance the turned footprint is judged at (= the 3D shelf's CAM_D). */
const PERSPECTIVE = 1400;

/**
 * Hover / selected "turn": the book swings round toward the guide's
 * BookDetail end pose (rotateY(-90deg)) to show its hinged front cover, lifts
 * a little and comes forward. Just past -90° the cream fore-edge shows beside
 * the cover. Used by the WebGL shelf (src/shelf3d/engine.ts).
 */
export const TURN = { angle: -98, lift: -16, pull: 28, ms: 550 } as const;
/** Clear space kept around a turned book when its neighbours part. */
export const PART_MARGIN = 12;

/** Extra left margin so a leaning book rests clear of its neighbour. */
export function leanMarginOf(e: Essay): number {
  return e.lean ? Math.ceil(e.height * Math.sin((Math.abs(e.lean) * Math.PI) / 180) * 0.85) : 0;
}

/**
 * Horizontal extent of a turned book (row units), relative to its slot's
 * left edge: the spine, hinged cover and page-block corners in perspective,
 * plus PART_MARGIN. Drives parting and hit-testing. Static per essay because
 * a turned book faces the camera wherever it stands on the drum.
 */
export function turnedFootprint(e: Essay): { left: number; right: number } {
  const w = e.width;
  const th = (TURN.angle * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  let lo = Infinity;
  let hi = -Infinity;
  // (x, z) corners in the mover's plane; z < 0 runs back into the shelf.
  for (const [px, pz] of [
    [0, 0],
    [w, 0],
    [w, -COVER_W],
    [0, -COVER_W],
  ] as const) {
    const x = px - w / 2; // transform-origin is the spine's centre
    const z = pz + e.depth;
    const x1 = x * cos + z * sin;
    const z1 = -x * sin + z * cos + TURN.pull;
    const X = w / 2 + x1 * (PERSPECTIVE / (PERSPECTIVE - z1));
    lo = Math.min(lo, X);
    hi = Math.max(hi, X);
  }
  return { left: lo - PART_MARGIN, right: hi + PART_MARGIN };
}
