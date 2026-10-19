# Interesting Reads — how we built it

A record of the steps, from the newsletter PDF to the finished 3D shelf. Written for AevyTV.

---

## 1. Turning the newsletter into data

**Source:** the "Interesting Reads" PDF — 57 pages, issues #1 to #51.

1. **Extracted every entry.** 285 listings across 50 issues (there is no #31), which became **283 unique items** after merging two that appeared twice: 252 essays/articles, 18 videos, 12 X posts and 1 book. Each record carries its id (e.g. `IR07-3`), issue(s), title, description, author, publication and format.
2. **Checked every link.** 267 open and are free to read, 12 are paid, 4 are broken. Bot-blocked sites were re-checked in a real browser.
3. **Found a link for every item.** Paid posts keep their official link (with a free archived copy where one exists); broken ones got a verified Wayback Machine copy or the creator's re-upload. One item has no working link anywhere (the author deleted it).
4. **Collected covers.** 270 cover images (the article's own share image; the real book cover for the one book). 13 items have no image and use a typeset title-only cover.
5. **Produced the deliverables:** `links/essays.json` and `essays.csv` (one record per item, every field), `links/interesting_reads_links.pdf` (24 pages, clickable, grouped by issue with a status label), and the `covers/` folder.

## 2. Planning the site

We designed the site as a **personal bookshelf of essays** rather than a list:

- **The shelf.** A curved, endlessly drifting 3D shelf of real books. Each spine takes its colour from that essay's cover; thickness, height, lean and wear vary by item so the shelf looks lived-in. The shelf loops at a constant speed for every topic, even a 10-book one.
- **Covers.** Most cover images are landscape, so each book face is designed like a classic paperback: title at the top, the image as a panel, author and publication at the foot.
- **Look and feel.** Warm paper tones, a serif for titles, a clean sans for body, small mono labels; slow, floating motion; one warm light from the top-left; the shelf sits directly on the page with no wall behind it.
- **Finding things.** A "What are you looking for?" search and topic pills (10 topics, each item tagged with one or two). A "read" counter that doubles as a filter.
- **Opening an essay.** Clicking a book pulls it out and lands it on a wooden table beside a card with the issue, description, topics, a Read / Watch / Read on X button (with a paid note and free copy where relevant), a read toggle, Previous / Next, Copy link and Shelve it.
- **Extras.** Surprise me, issue bookends, a share link per essay, and a "read" ribbon remembered in the visitor's browser.
- **Deferred on purpose:** AI-powered search (needs a key and a small server function; the search is built so it can be swapped in later) and a visitor "recommend an essay" shelf (needs a database and moderation).

## 3. Building the shelf in 3D

The first version used CSS 3D and could not hold a smooth frame rate with ~850 rendered spines, so we moved the shelf to **WebGL** with free, open-source tools (three.js, React Three Fiber, and Rapier for physics).

- **Scene.** Real book geometry (spine, hinged cover, page block with page-line edges, headbands on hardcovers), cloth / gloss / matte materials, soft contact shadows, a transparent canvas so the page colour shows through, soft fades at the shelf ends.
- **Text that stays crisp.** Spine faces and covers are drawn into texture atlases at load, with typeset page text inside open books.
- **Framing.** Books fill about 80% of the stage height; ~30 across on a laptop, ~11 on a phone; the camera never tilts.
- **Performance.** Direct-to-GPU updates with no React work per frame; adaptive quality tiers; a start-up compile of every shader so there is no first-use stall. Measured: well over 120 fps uncapped on desktop, 60+ fps on a 6× slowed CPU and on a phone profile.
- **Accessibility.** A hidden list of real buttons drives the shelf for keyboard and screen readers (one tab stop, arrow keys, Enter, Escape), a live caption, visible focus, and a plain list fallback if WebGL is unavailable. Reduced-motion users get a still shelf and instant moves.

## 4. The interactions

- **Hover:** the book lifts slightly and slides forward; it snaps back when the pointer leaves. No cover is shown on hover.
- **Click:** the same book slides out, turns to show its cover during the arc, and lands on the table, leaving its slot empty. Shelve it / Escape flies it back into exactly that slot. Previous / Next hand over smoothly; Surprise me spins the shelf, lands, and opens.
- **Changing topic:** books that don't belong tip off the front edge and tumble away (a pre-simulated, physics-based fall with covers flapping, checked before playback so it never looks wrong); books that do belong rise back up into their slots; the row closes up within about a second. The page height never changes.
- **Scrolling:** the mouse wheel moves the shelf only when the pointer is over the books; everywhere else it scrolls the page. On touch, vertical swipes scroll the page and sideways swipes move the shelf.
- **Links and state:** opening a book sets a shareable `#id` link; loading such a link opens that book; the page always starts at the top on reload.

## 5. Header, footer and polish

Typed title (caret fades when done), topic pills that wrap on desktop and scroll on phones, Instagram and YouTube icons top-right, "An interesting website by AevyTV" footer, a transparent caption row with Pause and Surprise me, self-hosted fonts for a fast first paint (books visible in ~0.5 s), and seam-free backgrounds checked by sampling the page colour top to bottom.

## 6. Robustness

Automatic recovery if a script file fails to load after a deploy; a watchdog that never leaves the shelf blank; covers guaranteed loaded before a book turns; no page jump on reload; no console errors or warnings in production.

## 7. How we tested

- **Three-agent workflow** for each bug report: one agent watched the screen recording frame by frame and wrote a timestamped defect report; one fixed every item; a third audited the fixes against the report and fixed what remained.
- **Automated suites** run against the production build in headless Edge on every change: fall choreography, hover sweeps, pull-out and return, link loads, wheel scoping, page layout and colour seams, cover readiness across quality tiers, functional checks, and phone / slowed-CPU profiles.
- **Frozen builds.** The preview link only ever served a build that had passed those suites and an independent check, so work-in-progress was never visible.

## 8. Running it

```
cd site
npm install
npm run build:data     # regenerates src/data/essays.ts and the WebP covers from ../links and ../covers
npm run dev            # local development
npm run build          # production build (BASE_PATH=/reads/ for a sub-path deploy)
```

The site is static and can be hosted anywhere (e.g. Cloudflare Pages, free, commercial use allowed). `site/README.md` documents every constant to change (title, palette, topics, hover and motion values), the test suites, and what was deliberately deferred.
