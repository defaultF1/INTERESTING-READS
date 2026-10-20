import { essays } from "../data/essays";
import { fontPreset } from "../lib/fontPreset";

/**
 * The families the shelf's canvases draw with (spine and cover lettering, the issue markers,
 * the pages), per typography preset (src/lib/fontPreset.ts): change a face here and every bake
 * follows (the page's own faces are the --face-* variables in src/styles.css; all are declared
 * in src/fonts.css).
 */
const SHELF_FONTS = {
  hand: {
    /** titles, the markers' "#N", page text */
    serif: '"Fraunces", Georgia, serif',
    /** tracked capitals: caps titles, authors, initials, small labels */
    sans: '"Inter", system-ui, sans-serif',
    /** the markers' "#N" and the covers' issue number */
    markerWeight: 600,
  },
  clean: {
    serif: '"Jost", "Futura", system-ui, sans-serif',
    sans: '"Jost", "Futura", system-ui, sans-serif',
    markerWeight: 500,
  },
} as const;
export const FONT: { serif: string; sans: string; markerWeight: number } = SHELF_FONTS[fontPreset()];

/**
 * The faces the shelf's canvases draw with, loaded explicitly and as early as possible:
 * this module starts the loads when the page's main bundle runs, in parallel with the 3D
 * chunk download and the WebGL context. No `document.fonts.ready` (it waits for every font
 * on the page).
 */
const SPECS = [`400 20px ${FONT.serif}`, `500 20px ${FONT.serif}`, `${FONT.markerWeight} 20px ${FONT.serif}`, `400 12px ${FONT.sans}`, `500 12px ${FONT.sans}`];

let loading: Promise<boolean> | null = null;

/** Starts (once) and resolves true when every face is ready, false if one failed. */
export function loadShelfFonts(): Promise<boolean> {
  if (loading) return loading;
  if (typeof document === "undefined" || !document.fonts) return (loading = Promise.resolve(false));
  // the characters actually drawn, so the latin-ext subsets load when a title needs them
  const chars = new Set<string>("AaZz09");
  for (const e of essays) for (const ch of e.title + e.author + e.publication) if (ch.charCodeAt(0) > 0x7e) chars.add(ch);
  const text = [...chars].join("");
  loading = Promise.all(SPECS.map((s) => document.fonts.load(s, text))).then(
    () => true,
    () => false,
  );
  return loading;
}

/** The fonts, but never wait longer than `ms` (slow network: bake with fallbacks, re-bake later). */
export function shelfFontsWithin(ms: number): Promise<boolean> {
  return Promise.race([loadShelfFonts(), new Promise<boolean>((r) => window.setTimeout(() => r(false), ms))]);
}
