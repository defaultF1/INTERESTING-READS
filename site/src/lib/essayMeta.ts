import type { Essay, EssayFormat } from "../data/essays";

export const FORMAT_LABEL: Record<EssayFormat, string> = {
  essay: "Essay",
  video: "Video",
  x_post: "X post",
  book: "Book",
};

export function readsLabel(issues: number[]): string {
  return `Interesting reads ${issues.map((n) => `#${n}`).join(", ")}`;
}

/** Primary call to action for the detail view. */
export function readLabel(e: Essay): string {
  if (e.linkType === "wayback") return "Read archived copy →";
  if (e.format === "video") return "Watch →";
  if (e.format === "x_post") return "Read on X →";
  return "Read →";
}

/** Tiny publisher mark for the foot of the spine: "NYT", "WIP", "PG"… */
export function publisherMark(publication: string): string {
  const cleaned = publication
    .replace(/\b(https?:\/\/)?(www\.)?/gi, "")
    .replace(/\.(substack\.)?(com|net|org|blog|co|ca|io|news)\b/gi, " ")
    .replace(/[|]/g, " ");
  const words = cleaned
    .split(/[^A-Za-z0-9À-ɏ]+/)
    .filter((w) => w && !/^(the|of|and|a|an|by|on|in)$/i.test(w));
  if (words.length === 0) return "IR";
  if (words.length === 1) {
    const w = words[0];
    // Split camel-case one-word names ("YouTube" -> "YT"); else take two letters.
    const caps = w.match(/[A-Z]/g);
    if (caps && caps.length >= 2) return caps.slice(0, 3).join("");
    return w.slice(0, 2).toUpperCase();
  }
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * Bookmark-ribbon candidates (crimson, gold, teal, ivory, ink). Not theme
 * colours: one is picked per book for contrast against its own palette.
 */
const RIBBONS = ["#b3322b", "#d9b04a", "#2f6f73", "#f4eee2", "#2a2420"];

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  // "redmean" weighted RGB distance: cheap and close enough to perceptual.
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

/** The ribbon colour that stands out most from a book's spine and band. */
export function ribbonColour(spine: string, band?: string): string {
  let best = RIBBONS[0];
  let bestScore = -1;
  for (const c of RIBBONS) {
    const score = Math.min(colourDistance(c, spine), band ? colourDistance(c, band) * 1.15 : Infinity);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** #rrggbb + alpha (0–1) -> #rrggbbaa. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex.slice(0, 7)}${a}`;
}
