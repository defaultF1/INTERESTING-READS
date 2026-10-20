# Interesting Reads

A personal 3D bookshelf of essays, videos and posts from the *Interesting Reads*
newsletter, on a flat black page with a hand-drawn feel: a handwritten headline and
labels, marker-line doodles, and colourful matte books.

- **The shelf.** Each read is a book in a matte paper jacket (one of a dozen rich
  colours with a faint paper grain, soft blended wave shapes at the foot or head, a serif
  title (a few in tracked capitals), the publication's initials in a circle), standing
  upright on a slim charcoal shelf traced in off-white marker, gently curved, drifting
  slowly in an endless loop when the row is wider than the view.
- **Hover.** Hover a book and it lifts and slides forward; a little doodled arrow points
  up at it and the caption under the shelf says what it is.
- **Click.** Click it and the book itself leaves the shelf: it slides out of its
  slot (tipping a little), lifts in an arc, turns to face you and lands on a sketched
  charcoal table that unfolds below the shelf, next to a black note card with the
  details. Its slot stays empty until "Shelve it" (or Escape) flies it back into it.
- **Topics.** Pick a topic and every other book tips off the shelf and tumbles out of
  view (real physics, simulated ahead and played back); nothing lands and nothing lies
  anywhere. Pick their topic again and they rise back into their places from below.

It's built from the [virtual-library-guide](https://github.com/carollia99/virtual-library-guide)
brief (written for Goodreads books) and adapted to essays; the interaction model has
changed since (no floating hover card, no full-screen pull-out). The stack is Vite,
React 19, TypeScript and Tailwind CSS v4. The shelf itself is **WebGL** (three.js
through `@react-three/fiber`) with **Rapier** physics for the falls, both loaded as
separate chunks after the header, title and search have painted. It's a single page
with no router and no server.

## Run it

Needs Node 20.19+ (tested on Node 24 / npm 11).

```bash
npm install
npm run build:data   # regenerate src/data/essays.ts + public/covers/*.webp
npm run dev          # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run build:data` | Reads `../links/essays.json`, `../covers/` and `scripts/topics.json`. Writes `src/data/essays.ts` and `public/covers/<id>.webp`. Re-runnable: unchanged covers are skipped (`-- --force` re-encodes all) and stale ones are deleted. |
| `npm run dev` | Dev server. |
| `npm run build` | `tsc -b` (strict, zero errors) then `vite build` into `dist/`. |
| `npm run preview` | Serves `dist/` locally. |

`src/data/essays.ts` and `public/covers/` are generated but meant to be committed, so
`npm run build` works even without the source `covers/` folder.

### Deploying under a sub-path

Set `BASE_PATH` when building, e.g. for `example.com/reads/`:

```bash
BASE_PATH=reads npm run build            # Git Bash / macOS / Linux
$env:BASE_PATH="/reads/"; npm run build  # PowerShell
```

`/reads/`, `/reads`, `reads` and full URLs all work. You can also put
`BASE_PATH=/reads/` in `.env.production`. In Git Bash, prefer `BASE_PATH=reads`: MSYS
rewrites `/reads/` into a Windows path (`vite.config.ts` recovers from that, but the
short form avoids it). Cover URLs are built from `import.meta.env.BASE_URL` (`asset()`
in the generated `essays.ts`). Share links use a hash (`#IR07-3`), so they work under
any base path and on static hosting.

### Bundle

| Chunk | Size | gzip | When |
|---|---|---|---|
| `index` (React, the page, 283 essays' data) | ~452 kB | ~132 kB | at once |
| `ShelfCanvas` (three.js, R3F, the scene, the falls' playback) | ~950 kB | ~265 kB | in parallel with the first render; the shelf fades in at ~320 ms on desktop |
| `simWorker` (a Web Worker: Rapier with its WASM inlined) | ~2.25 MB | ~830 kB | prefetched at idle ~1.2 s after the shelf is up (the main thread never loads Rapier); a topic click before that starts it immediately |
| CSS | ~40 kB | ~8 kB | at once |

## Using it

| Action | What happens |
|---|---|
| Hover a book | The book lifts a little (~14 px) and slides forward out of the row (~38 % of its depth), with no turn: its cover is not shown until it is opened. Ease out 180 ms (cubic-bezier(0.16, 1, 0.3, 1)), back in 120 ms; a 90 ms leave-grace so a sweep across the row does not flicker. Neighbours stay put. The caption (the title, handwritten, and publication · issue, plus a **Paid** tag) sets itself directly under the hovered book, centred on it and kept inside the page's gutters and clear of Pause / Surprise me, with a small doodled arrow from it up to the book; with nothing hovered the row shows the hint ("hover a book to see its name · click to open · hold to drag"). The caption row keeps its height. Hover is decided by column from the stable layout. Exactly one book is lifted at a time: moving to the next starts the last one settling the same frame. |
| Click | The pull-out starts from the lifted pose: the book slides fully out of its slot, then turns to show its cover during the arc to the reading desk below the shelf (the only time a cover shows on the shelf side), and the shelf glides to centre it. The cover it turns is always printed: the covers of the books in view are baked and uploaded at idle after load, the hovered book's ahead of a click, and the clicked book's on the spot before anything moves (the hi-res desk print; the desk's and the hi-res covers' programs are compiled and link-awaited before the shelf shows, with one off-screen warm frame of them in the start-up warm-up, and a production build skips the shader info-log queries at a program's first use, so the first open no longer stalls a frame: ~5 ms of render where it was ~210); should a print still be missing, the turn waits for it up to 150 ms and the shelf-res cover shows rather than a blank board. The URL becomes `#<id>`. A click in the empty band above a short book doesn't open it. |
| Previous / Next, ← / → in the panel | The adjacent book in the visible order: the shelf glides and the desk swaps. |
| Shelve it / Esc | The desk folds, the book goes back, and the hash is cleared. |
| Keyboard | The shelf is one tab stop: a visually hidden list of real buttons (one per book and bookend, in shelf order, roving `tabindex`). Tabbing in highlights the book at the centre, drawn as a two-tone ring projected onto the 3D book (dark inner, off-white outer, so ≥ 3:1 on any spine or the page). ← / → move book by book and glide. Enter / Space opens. Closing the desk with the keyboard returns focus and the ring to that book; a mouse close just lets go. The caption's details are announced politely for keyboard and touch browsing. |
| Touch | The first tap lifts the book (as a hover does), a second tap opens it. Over the shelf band a horizontal swipe moves the shelf (with momentum); vertical swipes scroll the page everywhere, the band included (`touch-action: pan-y`; a touch that sets off vertically is left to the page before anything moves). |
| Click, hold, drag | A quick click (press and release without moving) opens a book. A mouse / pen press held for 200 ms, or moved more than 6 px, is a drag instead: the shelf follows the pointer (with the fling), and letting go opens nothing. The cursor is a pointing hand only on a book itself, the closed hand while a press holds or drags, the arrow elsewhere. Touch is unchanged (tap / second tap / swipe). |
| Drag / wheel | Only over the **shelf band** (from just above the tallest book to the plank's bottom edge, the full width) do a drag and the wheel move the shelf, with momentum (a vertical wheel there scrolls the shelf sideways, as the guide has it). Over the header, the pills, the caption row, an open desk, the footer and the empty canvas above the books, the wheel and vertical swipes scroll the page as usual: the shelf's `wheel` listener checks the band before it prevents anything, and leaves alone a wheel the browser has already turned into a page scroll (one dispatched after the fact, not cancelable, when the band has scrolled under the pointer) and the rest of a sequence that started scrolling the page (a 150 ms latch, kept by a passive capture listener on `window`, the only other wheel listener there is). Floor books are reached by scrolling the page (or dragged). |
| Drift | 27 px/s on screen, time-based. It pauses while the pointer is over the shelf, while the desk is open, during drag / wheel / touch (resuming 2.5 s later), when the tab is hidden, with the **Pause** button (WCAG 2.2.2), and under `prefers-reduced-motion` (starts paused). A row that isn't wider than the view doesn't loop or drift (see below), and has no Pause button. |
| Surprise me | A heavy carousel spin: ramps up, cruises at ≤ 2400 px/s, then a long soft landing, 2000–3500 px in about 2.2–2.6 s, landing exactly centred on a random read from the current shelf, which then opens. The button is cream while it spins; on landing a hand-drawn ring circles the book's foot with a handwritten "this one!", fading as the book pulls out. Under reduced motion it jumps straight there (the doodle just shows briefly). |
| Topic pills | The books outside the topic fall off the shelf. The ones in view are pushed to the plank's edge and tip over it the moment the pill is clicked; meanwhile a Web Worker simulates the whole fall at 100 Hz (hinged covers for up to 40 fallers) and hands back every frame, which the page plays back from exactly the tipped pose. A faller is gone the moment all of it has passed the stage's bottom edge (the stage ends just under the caption row, or under an open desk): nothing lands, nothing lies anywhere, and the page's height never changes. The ones out of view are simply off the shelf. The remaining books slide together (eased, from 0.9 s) as the fallers clear; a row loops (at a constant 27 px/s) only when one copy of it is wider than the visible drum plus a margin each side (`LOOP_MARGIN` in `engine.ts`, decided again on every resize), so **no book is ever on screen twice**; a shorter row (a search with a few results, a small topic) shows each of its books once, centred if it fits, still, and Surprise me just glides to a match on it. Pick their topic again and the books rise into their slots from below the stage, each in an arc to just in front of its slot, holding there until the row has closed up, then sliding in. |
| Opening books | The fallers nearest the centre (40 on HIGH, 12 on MEDIUM / LOW) are hinged: front cover, page group and the back board with the rest of the pages on two sprung revolute joints at the spine (0° to ~150° / ~80°). The binding decides how a book flops as it tumbles: hardcovers are stiff and shut, paperbacks flop open; a fixed share per book (a hash of its id) is sprung open (a tent, or fanned with page edges showing and a faint typeset title on the first page; inside covers are plain cream). |
| Where they go | Nowhere: there is no floor. A book outside the topic is off the shelf (the page keeps the set), and the only book ever drawn off the shelf is one falling, one rising back, or the one on the desk. The page below the shelf is the caption row and, while a book is open, the desk; the canvas covers exactly that and is clipped by its wrapper, so a topic switch never changes the page's height. |
| "{n} read" | The header's read counter is a toggle: on, only the books you've read stay on the shelf and the rest fall (it intersects with the topic pill and the search). Off, they return. If every read is un-marked while it's on, it turns off by itself. Announced as "N books you've read (in {topic})". |
| Search | Narrows the shelf (in issue order, so the bookends stay meaningful) and glides to the best match; search alone never drops books off the shelf. A topic (or the read filter) chosen while a search is on counts the books outside it that the search had hidden as off the shelf too, so the shelf is the same whichever came first. |
| Issue bookends | Short mustard books with `#51` in the serif near the top sit between issues. Click one to glide to that issue's first read. |
| Copy link | Copies `…#<id>`. Opening that URL centres the book and opens the desk; an unknown id is cleared. |
| Read ribbon | Clicking Read / Watch / Read on X / an archived copy marks the essay read (`localStorage["ir:read"]`, guarded). Read books get a bookmark ribbon on the spine, on the shelf and in the air; the desk shows "You've read this" and a "Mark unread" / "Mark as read" button, and the header shows "{n} read". |
| Reduced motion | No drift, spin, falls or flights: books fade out of the shelf and back in, and the shelf closes up at once. |

## Where to change things

| What | Where |
|---|---|
| Typed heading ("Interesting Reads by AevyTV", two lines, no caret) | `FULL` in `src/components/TypedTitle.tsx` |
| Page title, description, og/twitter tags | `index.html` |
| "A personal archive" label, counters, the read toggle, social links, footer | `src/App.tsx` |
| Page colours (pure black page, off-white text, the doodles' marker colour) | `:root` in `src/styles.css` |
| Book colours (the 12-colour jacket palette, wave companions, the markers' mustard) | `PALETTE`, `COMPANIONS`, `MARKER_COLOUR` in `src/lib/bookStyle.ts` |
| Fonts | self-hosted `public/fonts/*.woff2` (from `@fontsource`, OFL), declared in `src/fonts.css`. The page: `--font-display` (Caveat, the headline and the desk card's title), `--font-sans` (Architects Daughter, every label, pill, button and the search) and `--font-serif` (Fraunces, the desk card's description) in `src/styles.css`. The books: `FONT` in `src/shelf3d/fonts.ts` (Fraunces titles, Inter tracked capitals). The headline's, the labels' and the spines' faces are preloaded in `index.html` |
| Doodles (the headline's arrow, the shelf's brackets, the hover arrow, "this one!") | `src/components/Doodles.tsx`; the note card's and the table's outlines: `src/components/Sketch.tsx`; the shelf's marker line: `lipTexture` in `src/shelf3d/bake.ts` |
| Topics (filter pills) | `scripts/topics.json` (id → 1–2 topics), then `npm run build:data`. The script refuses an item with no topic, more than 2, or more than 10 topics in total. |
| Hover lift (~14 px net on screen, slide 38 % of the depth, 180 ms out, 120 ms back) | `HOVER_LIFT_PX`, `HOVER_SLIDE`, `HOVER_MS`, `HOVER_BACK_MS` in `src/shelf3d/engine.ts` |
| The pull-out to the desk (pull 500 ms, arc 700 ms, land 200 ms; back in 1.1 s, 600 ms on Previous / Next; the hash load in 600 ms; the slide-out distance and tip, the desk tilt and roll) | the `PULL_*`, `ARC_MS`, `LAND_MS`, `SHELVE_*`, `FAST_MS`, `DESK_*` constants in `src/shelf3d/ground.ts` |

| Drift speed, resume delays, framing (headroom, eye height), fit-pan margin | constants at the top of `src/shelf3d/engine.ts` |
| Shelf curve (±24°, pow 1.35), the camera distance (`CAM_D`, 2400) | `src/shelf3d/curve.ts` |
| Loop threshold, bookend size, book depth, plank | `src/shelf3d/row.ts` |
| Stage height (an open desk adds its own height below it) | `STAGE_H` in `src/components/Shelf.tsx` |
| Lights, materials, quality tiers | `src/shelf3d/scene.ts`, `src/shelf3d/ShelfCanvas.tsx` |
| Spine / cover / marker-label artwork | `src/shelf3d/bake.ts` (canvas drawings, from `bookStyle()` in `src/lib/bookStyle.ts`); the DOM cover (no-WebGL fallback) is `src/components/CoverFace.tsx` |
| The fall (push, tip, hold-back, stagger, the simulation's rate and length), the hinges' rest angles and springs per binding, how a book's bindings are sprung (`hashId` → closed / tent / fanned), the return arcs, how many fallers are hinged (`hingedLimit`), the solver's ground (far below the stage) | `src/shelf3d/ground.ts` |
| Gravity (0.4 g, a touch of slow motion), friction, bounce, damping, the room's walls, the plank collider, the solver's length unit | `src/shelf3d/physics.ts` |
| Search ranking | `src/lib/search.ts` |

Topics in use: AI & Tech, Business & Startups, Money & Economics, Mind & Psychology,
Learning & Growth, Life & Philosophy, Culture & Society, World & Politics,
History & Science, India. (There is no separate format filter.)

## How it's built

- **`scripts/build-data.mjs`** uses **`sharp`** (a devDependency, prebuilt binaries, so
  no Python is needed).
  - **Covers** are re-encoded to WebP, 640px on the long side, at quality 72. That's
    about 7.5 MB for 270 images, down from 44 MB.
  - **Palette**: the data still carries the guide's `readCoverPalette` sample
    (`spine`, `band`, `ink`), but the books no longer use it: their jackets come from
    `src/lib/bookStyle.ts` at runtime (a colour per id from a hash, never the same as the
    item beside it in the full shelf order, bookends included, so a book keeps its colour
    under any filter; wave shapes, title style and ink by contrast from the same hash).
  - **Physical props** are deterministic from a hash of the id: binding from the
    format, widths 16–58, lean, depth, wear, face, caps, some foil titles.
  - **Order** is newest issue first.
- **The shelf (`src/shelf3d/`)**
  - `row.ts` — the row as a pure model: books and bookends laid out in row units. A
    looping row repeats by **modulo** (virtual index `v` → item `v mod K`), so the
    endless loop has no copies.
  - `curve.ts` — the drum: a real 3D arc, flat in the middle, turning to ±24° at the
    stage edges (a lookup table, inverted for hit-testing).
  - `engine.ts` — motion and interaction, renderer-agnostic and DOM-free per book:
    time-based drift, glides, the Surprise spin curve, fling / wheel momentum, the
    hover lift tweens (cubic-bezier(0.16, 1, 0.3, 1), 180 ms out, 120 ms back, each
    from wherever the book is; the hovered, keyboard-highlighted or first-tapped book
    rises ~14 px and slides out of the row along the shelf's normal, nothing turns and
    nothing parts), the turn tweens kept for a selected book (hidden while it is on
    the desk, so no cover shows on the shelf), column hit-testing, keyboard focus and
    the projected focus ring. It frames the
    camera from the stage size: the tallest book fills ~79% of the shelf band with
    ~11% headroom above the books, the plank and lip on a thin band below. A
    topic change is a **morph**: the book nearest the centre stays put, the rest
    slide from where they stood to their new slots (after the fallers clear), and
    books flying back get their slots at once but are drawn by the ground until they
    land. The camera is one fixed eye-level view.
  - `bake.ts` — Canvas 2D drawings of every spine (the jacket's colour and waves, the
    vertical title in Fraunces or tracked Inter capitals, the author in tiny capitals, the
    initials in a thin circle), the cover (the same jacket, `#N`, the serif title, the
    cover image as an inset panel or a large `#N`, author · publication), the pages, the
    markers' `#N` labels and the shelf lip's hand-drawn marker line.
  - `scene.ts` — three.js, imperative. Faces are packed into 2048² atlas pages,
    allocated empty on the GPU and filled one rectangle (with its mip levels) at a
    time; the books in view are drawn with a handful of **InstancedMesh** draw calls
    (page block with page lines on the top, tail and fore-edge, spines per atlas page
    with a per-instance uv rect and material, front and back boards, ribbons, contact
    blobs, bookends, plates). Books in motion off the shelf (falling, flying back, on
    the desk) are drawn part by part from the same instances (a closed book, or base +
    page group + cover + fanned leaves), with an inner-page atlas (cream paper, a faint
    title on the first page) for the insides of books that flop open as they fall. Per
    frame it only writes instance matrices for what's near the view.
  - `ground.ts` — the books off the shelf, in shelf-row space (x along the shelf,
    y up from the plank, z toward the viewer; `toWorld` maps it onto the drum):
    every book in motion off the shelf has exactly one state (`wait` → `fall` → gone,
    `return`; `flight` and `desk` for the book on the desk), so a rapid sequence of
    pills just retargets; the set of books off the shelf is kept as ids. A fall is
    **simulated first, then played back**: the on-screen leavers are sent to the
    worker as one job (deterministic per set) with the push to the plank's edge, the
    tip over it, a hold-back and a stagger (each book its own: tip 42 ± 4°, a slight
    yaw, its start 0–250 ms after the click, its spin ± 30 %, so no two fall as one
    sheet). The worker **streams its frames** as it simulates them (ten at a time, the
    first within ~20–50 ms of the click), and the playback starts on the first chunk
    that reaches the page's clock: the solver runs several times faster than real
    time, so the playback never catches up with it, and nothing waits for the whole
    fall to be simulated. Until then the page plays the very same push and tip
    kinematically. The path runs on the page's clock from the click and takes over
    from what the page shows: the pose offset at the join, measured against the frame
    the shown pose belongs to, eases away over 150–480 ms on the simulated path, so
    there is no kink, no jump and no frame lost; a join pose that would put a corner
    into the plank's wood gives up that much of its offset instead of being shoved
    forward. A faller is gone the moment every corner of it has passed the stage's
    bottom edge (the canvas ends there; its wrapper's mask fades the last 16 px), or
    when its frames run out; the solver's ground lies far below anything the stage
    can show, so nothing ever lands. A returner caught in the air by a topic that
    drops it again falls from where it is, with no push and no tip, unless it is
    already up on the plank. The clock is pause-tolerant: a frame longer than 50 ms
    while something moves (a compile, a hitch) shifts every fall and return by the
    gap, so books never jump ahead after a stall (desk flights keep the wall clock,
    so a stall there is caught up, not added); a long gap after the loop has rested
    (the drift paused, nothing moving) is not a stall.
    Returns are kinematic tweens: a book rises from below the stage's bottom edge
    under its slot (a book's height out of sight, a little in front, tumbled) along an
    arc to just in front of the slot (over the plank's lip, never through it); with
    books falling in view they wait until those have cleared the plank, and they hold
    in front of the slot until the row has closed up, then slide in, so a returner
    never enters a slot a kept book is still sliding through (a book new to the view,
    out of sight before, comes in the same way rather than sliding through its
    neighbours). A short looping row shows a book more than once: while the row
    changes, a kept book is held once where it stood and its other copies settle in
    from just above once the row has closed up. On a looping row a return keeps the
    copy of its slot it chose. A book opened mid-return carries on to the desk from
    where it is and returns to that slot afterwards.
    The desk's book is a ground item too: `toDesk` pulls it out of
    its slot (the shelf hides the slot), arcs it to the page's slot (unprojected onto
    a plane at the depth where its cover is the slot's width) and `fromDesk` flies it
    back to the exact slot, from wherever it is (cancellation at every stage); a book
    that leaves the row while on the desk or in flight falls from where it is.
  - `simWorker.ts` + `physics.ts` — the burst simulation in a Web Worker (a classic
    script, so browsers without module workers can start it; Rapier
    `@dimforge/rapier3d-compat`, pinned, bundled into the worker's own chunk: the main
    thread never loads it). A job carries the room and the fallers (boxes, or base + page
    group + cover with two revolute joints, the binding's spring and limits); it
    steps 2 s at 100 Hz (8 solver iterations, contacts at 80 Hz stiffness, a length
    unit of 0.1, contacts predicted 40 mm ahead and CCD on the fallers so nothing
    tunnels, hinged parts never self-collide; the colliders are the drawn parts'
    boxes), records every second step and posts the frames back as one
    `Float32Array`. A job unanswered for 4 s, or a worker that fails to load, lets
    its books tumble out plainly (a kinematic fall under gravity).
  - `ShelfCanvas.tsx` — the code-split R3F host: a demand-driven loop (nothing
    renders while the shelf is still), the quality tiers, context loss / restore and
    the never-blank safeguards. The canvas element takes its size inside the frame
    loop, right before the render, so a resized (blank) drawing buffer never reaches
    the screen; it grows past the shelf's band when a desk opens.
  - **Never blank.** The faces in view bake first (as fast as possible, in ~10 ms
    slices), the shaders compile in parallel (`KHR_parallel_shader_compile`; the
    page waits for them itself, with a guard for a material rebuilt meanwhile, so a
    hash load can never leave the shelf unready), the fonts the spines use are
    preloaded and loaded explicitly (no waiting on `document.fonts.ready`), and the
    shelf shows the moment those three are done, with a short staggered settle onto
    the plank. The rest bakes in idle time, nearest-first; a face that comes into
    view before the baker reaches it is baked on the spot within 5 ms a frame, past
    that in the next idle slice (its book draws plain for a frame or two). Typeset
    pages paint in budgeted idle slices too. Cover
    images load for a window around the view, at low priority, and repaint in idle
    time (never mid-spin). At idle after the shelf is up, the inner-page atlas and
    the desk's materials are allocated and compiled, so the first fall has no hitch. If the 3D shelf isn't ready 4 s after mount, the plain shelf shows
    until it is (one `console.warn` names the stage reached); a lazy chunk that fails
    to load (a deploy swapped the files under an open tab) reloads the page once,
    then falls back to the plain shelf; a shared link's read opens once the shelf is
    ready, with its book pulled out fast (600 ms).
  - **Text detail.** Atlas density follows the on-screen density (scale × DPR):
    spines 1.65–3 texels per unit, trilinear mipmaps, 16× anisotropy. A turned book
    gets a hi-res cover of its own; so does the book on the desk. The inner-page
    atlas carries a typeset text page (running header, justified paragraphs set from
    the essay's own sentences, a page number) for the page group's face and the
    fanned leaves, a title page inside the front cover, and the back cover is drawn
    plainly (bands, a blurb, a mark and a barcode).
  - **Quality tiers.** HIGH: shadow map (4096 × 2048 PCF soft, fitted to the shelf;
    the map itself is kept across refits, since re-allocating it stalled the first
    frame after a desk opened by ~100 ms), MSAA, DPR ≤ 2.
    MEDIUM: blob shadows only, MSAA, DPR ≤ 1.5 (≤ 2 on phones, where crisp titles
    matter more). LOW: DPR 1, no MSAA, no environment reflections. The first tier comes from a quick device check (cores, memory,
    coarse pointer, software GPU); it steps down automatically when the median frame
    time over a 90-frame window of motion exceeds 22 ms. MSAA is fixed when the
    context is created. Force one with `?tier=high|medium|low`.
  - **Robustness.** `webglcontextlost` hides the canvas and waits; `webglcontextrestored`
    re-allocates the atlases, re-bakes every face and regenerates the environment map.
    Without WebGL 2 (or `?nowebgl`, or a context that doesn't come back, or a canvas
    tree that throws), a static DOM shelf of flat spines takes over; the desk and
    everything else still work. A simulation worker that fails to load, or a job
    that never answers, lets the books tumble out plainly without it. The page always
    starts at the top (`history.scrollRestoration = "manual"`; no element carries an
    essay's id, so a hash never jumps the page): the page's height settles after
    load.
- **Accessibility.** The canvas is `aria-hidden`; the shelf for keyboards and screen
  readers is the hidden button list inside the `shelf` group (accessible names
  "Title by Author" / "Issue #N: n reads. Jump to it"), which always reflects the
  shelf (the current topic / read filter); the books outside the topic are off the
  shelf (pick their topic to bring them back). The live caption and the filter announcements use polite live
  regions.
- **Search.** `searchEssays(query): Promise<string[]>` in `src/lib/search.ts` is the
  only search entry point. Today it's a client-side ranked search (tokenized, every
  term must match, weighted fields). To add an AI endpoint (e.g. `POST /api/search` →
  `{ ids }`), change only that function and fall back to `localSearch()` on any error.

### One light, one room

Everything is lit from the top-left. The canvas is transparent: the page is flat black
(`#000`) from top to bottom, with no wall, light or grain layers, and every shadow the
scene draws is pure black (a tinted one would lift the page into a halo).

- **Shelf.** One warm directional key light from the top-left, a soft hemisphere fill
  and a PMREM'd `RoomEnvironment`. A slim matte charcoal plank (top, chamfer and front
  lip following the drum curve) whose lip is traced along its top and bottom edges with a
  slightly wobbly off-white marker line (a tiling texture, redrawn ~1.5 CSS px thick
  for the on-screen scale, so it is as crisp on a phone), and two doodled L brackets under
  it near the ends (DOM, placed by the engine from the drum's projection, under the
  canvas). The shadows the books cast are caught by invisible planes (a soft baked shadow
  on every tier, real shadow-map shadows on HIGH). The ends fade softly into the page.
- **Books** are solid: spine (with a gently rounded normal), front and back boards
  (the back prints the cover duller), a cream page block with real page lines on the
  top, tail and fore-edge, a headband on hardcovers. Every jacket is matte paper
  (no gloss, foil, deboss or wear). Issue markers are short (126 units) mustard books.
- **Desk.** A sketched table under the canvas: a slim charcoal top traced in marker, its
  front edge and two legs (`SketchTable`), sized from the layout so the book always lies
  wholly on the top (on phones the table carries the book only and the card follows below
  its legs). The 3D book lies on it (tilted back 12°, rolled 3°, with a soft contact
  shadow) and a black note card traced in marker sits above the canvas. There is no
  second drawing of the book: the one on the shelf is the one on the desk.
- **Doodles.** Arrows only where they point at something: a curly arrow beside the
  headline pointing down toward the search and the shelf (hidden on phones), an arrow from
  the caption up to the hovered book, one at the Read button, and on a Surprise landing
  a ring round the chosen book's foot with a handwritten "this one!" (drawn in, then
  fading as the book pulls out; under reduced motion it just shows briefly).
- **Caption.** While a book flies to or from the desk, and while books in view tip, fall
  or fly back to the shelf, the caption's text fades out of its way (150 ms) and back once
  everything has landed; the buttons stay. (The faint caption seen in a recording was this
  DOM caption mid fade-in, 120 ms, on a bookend hover: nothing is drawn in the scene.)
- **Contrast.** Text is off-white `#F3EFE7` on black; muted text uses `--muted-foreground`
  (`#A39E95`, ≈7.4:1 on the page) without alpha. Focus rings are off-white.

## Testing hooks

- `data-testid` values (stable):
  - `search-input`, `topic-pills`, `topic-pill` (with `data-topic`, `aria-pressed`),
    `title-caret` (only while the title types), `read-count` (a toggle button,
    `aria-pressed`)
  - `shelf` (has `data-ready` once the 3D shelf is shown), `shelf-caption`, `shelf-empty` (shown when nothing
    matches), `drift-toggle`, `surprise-me`
  - `detail-panel` (has `data-open` while open), `desk-slot` (the place the 3D book
    lands in; `data-landed` once it lies there), `read-link`, `free-copy-link`,
    `copy-link`, `panel-prev`, `panel-next`, `panel-close`, `read-toggle`
    (`data-state`), `read-count`
  - the plain (no-WebGL) shelf has `data-fallback`
- Inside `[data-testid="shelf"]`, every shelf book is a (visually hidden) `button`
  with `data-essay-id` (and `data-read` when read); bookends have `data-issue`. They
  are real buttons: focus, Enter and screen readers work; for pointer automation use
  the coordinates from `__shelf.rects()`.
- **`?debug`** exposes `window.__shelf`: `hovered`, `selected`, `kbd` (ids), `pos`,
  `gliding`, `ready`, `tier`, `blankFrames`, `frames`, `lateBakes`, `rects()`
  (visible shelf books / bookends with projected viewport rects and spine centres
  `cx`, `cy`), `flightRects()` (the books in motion off the shelf: their projected
  rects and block centres, pitch, cover opening and fan, how the front cover faces the
  camera, the box in row space, whether it passes through the plank, its arc position,
  depth and bottom), `plank()` (the plank's box), `band()` (the shelf band in stage
  px), `ground()` (how many books are off the shelf, the items in motion and their
  states, the worker ready, the simulation stats: jobs, fallbacks, the last and the
  longest job in ms, the apply time; the last job sent; the join log, the hand-offs
  from the staging to a simulated path, with how far the pose was off, the frames it
  was measured between and how long the offset eases; the clamp log, the frames the
  playback wanted before the worker had sent them; and the stalls, the long frames
  absorbed by the pause-tolerant clock, never counting the loop's own rests),
  `desk()` (the desk's book: its flight stage, the page's slot and the book's
  projected rect), `flights()` (every book flying to or from the desk, and how
  exactly the last one shelved met its slot), `pageTexture(id, kind)` (a data URL of
  a baked page), `timing()` (the slowest frame's parts, the list change and the
  ground's apply in ms), `camera()`, `stats(n?)` (fps, median, p95, std, judder,
  per-frame shelf CPU), `intervals(n?)`, `resetStats()`, `info()` (tier, GPU,
  step-downs, texture MB, atlas pages and densities, bake timings, start-up timings:
  `visible` is "time to books visible" from navigation start), and `engine` (with
  `engine.ground` the ground controller).
- `?tier=high|medium|low` locks a tier; `?nowebgl` forces the DOM fallback.
- The drift moves the shelf continuously. For pixel-stable automation, click
  `drift-toggle` first or emulate `prefers-reduced-motion: reduce`.

## Intentionally skipped (can be added later)

- The **"Recommend a book"** dialog, the **"Recommended to me"** shelf,
  `useRecommendations`, the Open Library helpers and the **database** (guide sections
  6–7).
- The **server-side AI search** (guide section 5). See "Search" above.
- The guide's **portaled hover card** and **full-screen BookDetail pull-out** were
  replaced by the caption and the inline reading desk, as the later spec asked.

## Notes and deviations

- The first open of a desk after load has one long main-thread task (~110-170 ms on a
  desktop, measured with a devtools trace: the panel's first content render, one 39 ms
  layout of ~60 nodes, style and paint of the card); a second open costs 4-8 ms. It is
  DOM, not GL (the 3D side of a first open is ~5 ms of render after the start-up warm-up).
  A hidden pre-mount of the panel at idle would absorb most of it, but the panel manages
  focus and scrolling on open, so that is left for a later pass.

- **Page height.** Earlier builds grew the canvas past the stage the moment a desk opened
  (to be ready for a floor band below the desk, a design since dropped), which scrolled the page a viewport past
  the footer into a region the page root does not cover, where the grain layer blends with
  nothing and reads greyer, with a hard seam at the footer. The canvas now follows the stage
  (shelf, caption row, an open desk), its wrapper clips it, and
  the root clips overflow in both axes, so the document always ends with the footer.
- **Paths.** The guide's `__root.tsx` is now `index.html` + `src/main.tsx`, and
  `routes/index.tsx` is now `src/App.tsx`.
- **Turn angle.** The turn is −98° (just past the guide's −90° end pose), so the cream
  fore-edge shows beside the cover.
- **Leaning books.** A leaning book gets a little extra left margin so it rests clear
  of its neighbour.
- **WebGL.** The shelf moved from CSS 3D (thousands of preserve-3d layers) to WebGL for
  performance; the header, search, caption, desk and all controls are still DOM. The
  physics uses Rapier directly rather than `@react-three/rapier`, in a Web Worker: the
  scene is imperative and instanced, and per-body React components would add React
  work every frame.
- **No floor.** The brief had the fallen books lying on a floor under the shelf (a
  pile with physics, heaps beyond the view, pick-up and throw). The design dropped it:
  the falls stay exactly as they were (tip off the plank's edge, tumble with the covers
  flapping, simulated ahead and played back) but a book is gone once it has passed the
  stage's bottom edge, and the ones that belong again rise from below the stage into
  their slots. So nothing lands, nothing lies anywhere, no part of the page is reserved
  for a floor, and a topic switch never changes the page's height. The drift's 27 px/s
  is measured at the drum's centre (a book at the sides moves ~25 px/s on screen as
  the drum turns away).
- **Rapier's init warning.** rapier3d-compat's own `init()` hands its inlined WASM
  to the wasm-bindgen loader in the deprecated positional form; the build strips
  that one `console.warn` from the worker's bundle.
