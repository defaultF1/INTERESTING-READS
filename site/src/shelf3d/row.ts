import type { Essay } from "../data/essays";
import { leanMarginOf, turnedFootprint } from "../components/bookFaces";

/**
 * The shelf row as a pure model: items (books and issue bookends) laid out
 * left to right in "row units" (1 unit = 1 CSS px of spine at the drum's
 * front). A looping row repeats forever: virtual index v maps to item
 * k = v mod K in copy c = floor(v / K), so the loop needs no DOM copies and
 * wraps by modulo.
 */

const GAP = 2;
export const MARKER_W = 24;
/** issue markers are short books: ~57 % of the average essay's height */
export const MARKER_H = 126;
/** and as deep as a (slim) book */
export const MARKER_D = 150;
export const BOOK_DEPTH = 178; // the guide's COVER_W: how far a book goes back
/** The plank: its front edge sits this far in front of the spines; the lip is this thick. */
export const PLANK_FRONT = 40;
export const LIP = 18;
/** rows with fewer books than this have no bookends (they would repeat every few books) */
const MIN_BOOKS_FOR_MARKERS = 8;

export type RowItem =
  | { kind: "book"; essay: Essay; key: string; w: number; h: number; margin: number; fp: { left: number; right: number } }
  | { kind: "marker"; issue: number; count: number; key: string; w: number; h: number; margin: number };

function upperBound(arr: Float64Array, n: number, x: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Row {
  readonly items: RowItem[];
  readonly K: number;
  /** left edge / width / centre of each item inside one copy */
  readonly left: Float64Array;
  readonly width: Float64Array;
  readonly center: Float64Array;
  /** one copy's period (includes the trailing gap) */
  readonly S: number;
  /** content length of one copy */
  readonly length: number;
  /**
   * Whether the row repeats forever. Only a row whose one copy is wider than the view loops (a
   * book is never on screen twice): the engine decides it for the view's width (`loopMin`);
   * a shorter row shows each book once, centred, and doesn't drift.
   */
  looping: boolean;
  private readonly index = new Map<string, number>();

  constructor(essays: Essay[], loopMin = 0) {
    const items: RowItem[] = [];
    // a very short row is tiled around the drum many times: bookends every few books would look odd
    const markers = essays.length >= MIN_BOOKS_FOR_MARKERS;
    let i = 0;
    while (i < essays.length) {
      const issue = Math.max(...essays[i].issues);
      let j = i;
      while (j < essays.length && Math.max(...essays[j].issues) === issue) j++;
      if (markers) items.push({ kind: "marker", issue, count: j - i, key: `issue-${issue}`, w: MARKER_W, h: MARKER_H, margin: 0 });
      for (let k = i; k < j; k++) {
        const e = essays[k];
        items.push({
          kind: "book",
          essay: e,
          key: e.id,
          w: e.width,
          h: e.height,
          margin: leanMarginOf(e),
          fp: turnedFootprint(e),
        });
      }
      i = j;
    }
    this.items = items;
    this.K = items.length;
    this.left = new Float64Array(this.K);
    this.width = new Float64Array(this.K);
    this.center = new Float64Array(this.K);
    let x = 0;
    items.forEach((it, k) => {
      x += it.margin;
      this.left[k] = x;
      this.width[k] = it.w;
      this.center[k] = x + it.w / 2;
      x += it.w + GAP;
      this.index.set(it.kind === "book" ? it.essay.id : it.key, k);
    });
    this.S = Math.max(1, x);
    this.length = Math.max(0, x - GAP);
    this.looping = this.K > 0 && this.S >= loopMin;
  }

  kOf(v: number): number {
    const K = this.K;
    return ((v % K) + K) % K;
  }
  copyOf(v: number): number {
    return Math.floor(v / this.K);
  }
  item(v: number): RowItem {
    return this.items[this.kOf(v)];
  }
  isBook(v: number): boolean {
    return this.item(v).kind === "book";
  }
  centerOf(v: number): number {
    return this.copyOf(v) * this.S + this.center[this.kOf(v)];
  }
  leftOf(v: number): number {
    return this.copyOf(v) * this.S + this.left[this.kOf(v)];
  }
  widthOf(v: number): number {
    return this.width[this.kOf(v)];
  }
  /** Item index k of an essay (or "issue-N" key). */
  kOfId(id: string): number | undefined {
    return this.index.get(id);
  }
  /** The virtual index of item k whose copy is nearest row coordinate r. */
  nearestV(k: number, r: number): number {
    if (!this.looping) return k;
    const c = Math.round((r - this.center[k]) / this.S);
    return c * this.K + k;
  }
  /** Virtual index whose slot contains row coordinate r (clamped for non-looping rows). */
  vAt(r: number): number {
    if (!this.looping) {
      const k = Math.min(this.K - 1, Math.max(0, upperBound(this.left, this.K, r) - 1));
      return k;
    }
    const c = Math.floor(r / this.S);
    const local = r - c * this.S;
    const k = Math.min(this.K - 1, Math.max(0, upperBound(this.left, this.K, local) - 1));
    return c * this.K + k;
  }
  /** First/last virtual index overlapping [a, b] (row coordinates). */
  vRange(a: number, b: number): [number, number] {
    if (!this.looping) return [0, this.K - 1];
    return [this.vAt(a) - 1, this.vAt(b) + 1];
  }
  /** Next book from v in direction dir (skipping bookends), wrapping round. */
  stepBook(v: number, dir: 1 | -1): number {
    let j = v;
    for (let i = 0; i < this.K + 1; i++) {
      j += dir;
      if (!this.looping) j = ((j % this.K) + this.K) % this.K;
      if (this.isBook(j)) return j;
    }
    return v;
  }
}
