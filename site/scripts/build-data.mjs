#!/usr/bin/env node
/**
 * Build-time data step for Interesting Reads.
 *
 *   npm run build:data            (re-encodes only covers whose source changed)
 *   npm run build:data -- --force (re-encodes every cover)
 *
 * Reads   ../links/essays.json, ../covers/*, scripts/topics.json
 * Writes  src/data/essays.ts        (the single source of truth for shelf + search)
 *         public/covers/<id>.webp   (covers, max 640px on the long side)
 *
 * Image work uses `sharp` (a devDependency), so no Python is needed.
 * The spine palette is sampled the same way the guide's `readCoverPalette`
 * does it in the browser: draw the cover 80px wide, average the left 6% into
 * `spine`, take the most saturated mid-luminance pixel as `band`, and pick a
 * dark or light `ink` from the spine's luminance.
 */
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const ROOT = path.resolve(SITE, "..");
const ESSAYS_JSON = path.join(ROOT, "links", "essays.json");
const TOPICS_JSON = path.join(HERE, "topics.json");
const OUT_TS = path.join(SITE, "src", "data", "essays.ts");
const OUT_COVERS = path.join(SITE, "public", "covers");

const FORCE = process.argv.includes("--force");
const COVER_MAX = 640; // px on the long side (largest on-screen use: detail view at 2x DPR)
const WEBP_QUALITY = 72;
const MAX_TOPICS = 10;

// ---------------------------------------------------------------------------
// Deterministic randomness: FNV-1a hash of the id seeds a mulberry32 stream.
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
const toHex = (r, g, b) =>
  "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function hslSat(r, g, b) {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return 0;
  return d / (1 - Math.abs(2 * l - 1));
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const INK_DARK = "#241f19";
const INK_LIGHT = "#faf7f0";

/** readCoverPalette, at build time. */
async function readCoverPalette(file) {
  const { data, info } = await sharp(file)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: 80 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const edgeW = Math.max(1, Math.round(w * 0.06));

  // spine: left 6% averaged
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < edgeW; x++) {
      const i = (y * w + x) * ch;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      n++;
    }
  }
  sr /= n; sg /= n; sb /= n;

  // band: most saturated mid-luminance pixel
  let best = -1;
  let band = null;
  let anyBest = -1;
  let anyBand = null;
  for (let i = 0; i < w * h * ch; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const s = hslSat(r, g, b);
    const L = lum(r, g, b);
    if (L >= 0.25 && L <= 0.75 && s > best) {
      best = s;
      band = [r, g, b];
    }
    if (s > anyBest && L > 0.08 && L < 0.92) {
      anyBest = s;
      anyBand = [r, g, b];
    }
  }
  if (!band) band = anyBand;
  const spineLum = lum(sr, sg, sb);
  if (!band || hslSat(...band) < 0.08) {
    // Monochrome art: settle the band between spine and ink so the rules still read.
    const t = spineLum > 0.55 ? 0.42 : 0.38;
    const target = spineLum > 0.55 ? [36, 31, 25] : [250, 247, 240];
    band = [sr + (target[0] - sr) * t, sg + (target[1] - sg) * t, sb + (target[2] - sb) * t];
  }
  return {
    spine: toHex(sr, sg, sb),
    band: toHex(...band),
    ink: spineLum > 0.55 ? INK_DARK : INK_LIGHT,
  };
}

/** The guide's HSL fallback palette, for items with no cover. */
function fallbackPalette(rnd) {
  const hue = rnd() * 360;
  const spine = hslToRgb(hue, 22 + rnd() * 16, 24 + rnd() * 14);
  const band = hslToRgb(hue + 25 + rnd() * 35, 42 + rnd() * 18, 52 + rnd() * 12);
  return {
    spine: toHex(...spine),
    band: toHex(...band),
    ink: lum(...spine) > 0.55 ? INK_DARK : INK_LIGHT,
  };
}

// ---------------------------------------------------------------------------
// Physical props (deterministic per id). Essays have no page count, so the
// binding comes from the format and the width from the hash.
// ---------------------------------------------------------------------------
const BINDING_BY_FORMAT = { book: "hardcover", essay: "paperback", video: "mass", x_post: "mass" };

function physical(id, format) {
  const rnd = mulberry32(fnv1a(id));
  // Draw every value up front so each field always uses the same slot.
  const r = Array.from({ length: 14 }, rnd);
  const binding = BINDING_BY_FORMAT[format] ?? "paperback";
  const finish = binding === "hardcover" ? "cloth" : r[0] < 0.5 ? "gloss" : "matte";
  const height =
    binding === "hardcover"
      ? 236 + r[1] * 18
      : binding === "mass"
        ? 196 + r[1] * 14
        : 214 + r[1] * 16;

  // Width: clamp 16–58, weighted so most essays land between 20 and 36.
  let width;
  if (binding === "hardcover") width = 46 + r[2] * 12;
  else if (r[3] < 0.07) width = 16 + r[4] * 4;
  else if (r[3] < 0.86) width = 20 + ((r[4] + r[5]) / 2) * 16;
  else width = 36 + r[4] * 14;
  if (binding === "mass") width *= 0.86;

  const lean = r[6] < 0.14 ? -(1.5 + r[7] * 3.5) : 0; // -5..0, most stand straight
  const depth = -7 + r[8] * 14; // -7..7
  const wear = r[9] * 0.35; // 0..0.35
  const face = r[10] < 0.5 ? "serif" : r[10] < 0.8 ? "sans" : "mono";
  const caps = face === "serif" ? r[11] < 0.2 : r[11] < 0.55;
  // A few hardcovers get foil-stamped titles.
  const foil = binding === "hardcover" && r[12] < 0.8;

  return {
    binding,
    finish,
    face,
    caps,
    foil,
    width: clamp(Math.round(width), 16, 58),
    height: Math.round(height),
    lean: round(lean, 1),
    depth: round(depth, 1),
    wear: round(wear, 2),
    rnd, // continues the same stream (used for the fallback palette)
  };
}

// ---------------------------------------------------------------------------
async function isFresh(src, dest) {
  if (FORCE || !existsSync(dest)) return false;
  const [a, b] = await Promise.all([stat(src), stat(dest)]);
  return b.mtimeMs >= a.mtimeMs;
}

async function main() {
  const raw = JSON.parse(await readFile(ESSAYS_JSON, "utf8"));
  const topicsMap = JSON.parse(await readFile(TOPICS_JSON, "utf8"));
  await mkdir(OUT_COVERS, { recursive: true });
  await mkdir(path.dirname(OUT_TS), { recursive: true });

  // ---- validate topics --------------------------------------------------
  const problems = [];
  const topicSet = new Set();
  for (const e of raw) {
    const t = topicsMap[e.id];
    if (!Array.isArray(t) || t.length === 0) problems.push(`${e.id}: no topics in scripts/topics.json`);
    else if (t.length > 2) problems.push(`${e.id}: more than 2 topics`);
    else t.forEach((x) => topicSet.add(x));
  }
  for (const id of Object.keys(topicsMap)) {
    if (!raw.some((e) => e.id === id)) console.warn(`warn: topics.json has unknown id ${id}`);
  }
  if (topicSet.size > MAX_TOPICS) problems.push(`${topicSet.size} distinct topics (max ${MAX_TOPICS})`);
  if (problems.length) {
    console.error("Topic assignment problems:\n  " + problems.join("\n  "));
    process.exit(1);
  }

  // ---- covers + palette ---------------------------------------------------
  const out = [];
  const wanted = new Set();
  let converted = 0;
  let reused = 0;
  const order = raw.map((e, i) => ({ e, i }));

  for (const { e, i } of order) {
    const phys = physical(e.id, e.format);
    let palette;
    let cover;
    let coverRatio;
    const src = e.cover_file ? path.join(ROOT, e.cover_file) : "";
    if (src && existsSync(src)) {
      const name = `${e.id}.webp`;
      const dest = path.join(OUT_COVERS, name);
      wanted.add(name);
      if (await isFresh(src, dest)) {
        reused++;
      } else {
        await sharp(src)
          .rotate()
          .flatten({ background: "#ffffff" })
          .resize({ width: COVER_MAX, height: COVER_MAX, fit: "inside", withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY, effort: 5, smartSubsample: true })
          .toFile(dest);
        converted++;
      }
      const meta = await sharp(dest).metadata();
      coverRatio = round(meta.width / meta.height, 3);
      cover = `covers/${name}`;
      palette = await readCoverPalette(src);
    } else {
      if (src) console.warn(`warn: ${e.id} cover file missing: ${e.cover_file}`);
      palette = fallbackPalette(phys.rnd);
    }

    const linkType = e.link_url ? e.link_type : "none";
    const freeCopy =
      linkType === "paid" && e.free_url && e.free_url !== e.link_url ? e.free_url : undefined;

    out.push({
      sortIssue: Math.max(...e.issues),
      sortIndex: i,
      essay: {
        id: e.id,
        title: e.title.trim(),
        author: e.author.trim(),
        publication: e.publication.trim(),
        description: (e.description || "").trim(),
        issues: e.issues,
        format: e.format,
        topics: topicsMap[e.id],
        link: e.link_url || "",
        linkType,
        ...(freeCopy ? { freeCopy } : {}),
        status: e.original_status,
        ...(cover ? { cover, coverRatio } : {}),
        binding: phys.binding,
        finish: phys.finish,
        spine: palette.spine,
        band: palette.band,
        ink: palette.ink,
        face: phys.face,
        caps: phys.caps,
        ...(phys.foil ? { foil: true } : {}),
        width: phys.width,
        height: phys.height,
        lean: phys.lean,
        depth: phys.depth,
        wear: phys.wear,
      },
    });
  }

  // Remove covers that no longer belong to any essay (keeps re-runs clean).
  for (const f of await readdir(OUT_COVERS)) {
    if (f.endsWith(".webp") && !wanted.has(f)) await unlink(path.join(OUT_COVERS, f));
  }

  // Newest issue first; within an issue keep the newsletter's own order.
  out.sort((a, b) => b.sortIssue - a.sortIssue || a.sortIndex - b.sortIndex);

  // ---- emit src/data/essays.ts ------------------------------------------------
  // One field per line, values compact. The cover is emitted as an expression
  // (asset("covers/…")) so it follows Vite's base path at build time.
  const body = out
    .map(({ essay }) => {
      const lines = Object.entries(essay).map(([k, v]) =>
        k === "cover" ? `    ${k}: asset(${JSON.stringify(v)}),` : `    ${k}: ${JSON.stringify(v)},`,
      );
      return `  {\n${lines.join("\n")}\n  }`;
    })
    .join(",\n");

  const ts = `// AUTO-GENERATED by scripts/build-data.mjs from ../links/essays.json,
// ../covers/ and scripts/topics.json. Do not edit by hand: change the inputs
// and run \`npm run build:data\`.

export type EssayFormat = "essay" | "video" | "x_post" | "book";
export type LinkType = "free" | "paid" | "wayback" | "official_alt" | "none";

export type Essay = {
  id: string;
  title: string;
  author: string;
  publication: string;
  description: string;          // the guide's blurb
  issues: number[];             // Interesting Reads issue numbers
  format: EssayFormat;
  topics: string[];             // 1–2 tags shown as filter pills
  link: string;                 // the link to show ("" when no longer available)
  linkType: LinkType;
  freeCopy?: string;            // free archived copy for paid links
  status: "OK" | "PAYWALLED" | "BROKEN";
  cover?: string;               // social image, shown as a plate on the cover
  coverRatio?: number;          // cover width / height
  binding: "hardcover" | "paperback" | "mass";
  finish: "cloth" | "gloss" | "matte";   // spine surface material
  spine: string;                // base colour, sampled from the cover's left edge
  band?: string;                // accent pulled from the cover art
  ink: string;                  // lettering colour
  face: "serif" | "sans" | "mono";       // lettering style
  caps?: boolean;
  foil?: boolean;               // foil-stamped title (some hardcovers)
  width: number;                // spine width in px
  height: number;               // spine height in px
  lean: number;                 // degrees of lean on the shelf
  depth: number;                // how far forward/back the essay sits, px
  wear: number;                 // 0–1 edge wear and ink fade
  spineImage?: string;
};

/** Public asset URL that respects Vite's \`base\` (BASE_PATH). */
const asset = (p: string) => import.meta.env.BASE_URL + p;

export const essays: Essay[] = [
${body}
];
`;
  await writeFile(OUT_TS, ts, "utf8");

  // ---- report ---------------------------------------------------------------
  let bytes = 0;
  for (const f of await readdir(OUT_COVERS)) bytes += (await stat(path.join(OUT_COVERS, f))).size;
  const counts = {};
  for (const { essay } of out) for (const t of essay.topics) counts[t] = (counts[t] || 0) + 1;
  console.log(`essays: ${out.length}  (with cover ${wanted.size}, without ${out.length - wanted.size})`);
  console.log(`covers: ${converted} converted, ${reused} up to date, ${(bytes / 1024 / 1024).toFixed(2)} MB total`);
  console.log("topics:", Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
  console.log(`wrote ${path.relative(SITE, OUT_TS)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
