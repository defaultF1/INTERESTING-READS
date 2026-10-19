import { essays } from "../data/essays";

/**
 * The faces the shelf's canvases draw with (spine lettering, covers, plates),
 * loaded explicitly and as early as possible: this module starts the loads
 * when the page's main bundle runs, in parallel with the 3D chunk download
 * and the WebGL context. No `document.fonts.ready` (it waits for every font
 * on the page).
 */
const SPECS = [
  `500 20px "Cormorant Garamond"`,
  `italic 300 20px "Cormorant Garamond"`,
  `400 12px "Karla"`,
  `400 10px "Space Mono"`,
  `700 10px "Space Mono"`,
];

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
