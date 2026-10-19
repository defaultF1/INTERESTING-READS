# Interesting Reads

A personal 3D bookshelf of the essays from the *Interesting Reads* newsletter (issues 1–51, 283 items), by AevyTV.

Made for AEVY TV, for the essays they share over the carousels on their Instagram channel.

- `site/` — the website (Vite + React + three.js). See [site/README.md](site/README.md) for how to run, build and customise it.
- `links/` — the essay data: `essays.json` / `essays.csv` (one record per item) and `interesting_reads_links.pdf` (every link, grouped by issue).
- `covers/` — the original cover images; `site/public/covers/` holds the optimised WebP versions the site uses.
- [BUILD-STEPS.md](BUILD-STEPS.md) — how the site was planned and built.

Quick start:

```
cd site
npm install
npm run dev
```
