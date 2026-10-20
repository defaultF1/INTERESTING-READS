/**
 * The site's typography, switchable in one place. Change FONT_PRESET and the whole site
 * follows: the page's faces (src/styles.css reads `data-font` on <html>, set in main.tsx),
 * and the books' lettering (src/shelf3d/fonts.ts, baked by src/shelf3d/bake.ts). Both
 * presets' fonts are shipped (src/fonts.css); `?font=clean` / `?font=hand` on the URL
 * previews the other one.
 *
 *   hand   the handwritten page: Caveat headline, Architects Daughter labels, Fraunces /
 *          Inter on the books
 *   clean  a thin geometric sans throughout: Jost (light headline, tracked capitals for the
 *          labels, Jost on the books; the desk's description keeps Fraunces)
 */
export type FontPreset = "hand" | "clean";

export const FONT_PRESET: FontPreset = "hand";

/** The preset in use: the URL's `?font=` if it names one, else FONT_PRESET. */
export function fontPreset(): FontPreset {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("font");
    if (q === "hand" || q === "clean") return q;
  }
  return FONT_PRESET;
}
