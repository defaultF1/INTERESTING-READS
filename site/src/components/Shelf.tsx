import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { essays as ALL_ESSAYS, type Essay } from "../data/essays";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { setRead, useReadSet } from "../hooks/useReadSet";
import { ShelfEngine3D, type DeskRect } from "../shelf3d/engine";
import { reloadOnceOnChunkFailure } from "../lib/reload";
import { MARKER_COLOUR, MARKER_INK, bookStyle } from "../lib/bookStyle";
import { MARKER_H, Row, type RowItem } from "../shelf3d/row";
import type { CanvasInfo } from "../shelf3d/ShelfCanvas";
import { loadShelfFonts } from "../shelf3d/fonts";
import { FrameStats } from "../shelf3d/stats";
import { DetailPanel } from "./DetailPanel";
import { Bracket, ThisOne, UpArrow } from "./Doodles";
import { ShelfCaption } from "./ShelfCaption";

/**
 * three + R3F + the scene are a separate chunk; its download starts as soon as
 * this module runs (in parallel with React's first render), and so do the
 * fonts the spines are lettered in. It mounts the moment it arrives: a plain
 * dynamic import into state, not React.lazy + Suspense (React 19 throttles a
 * Suspense reveal by ~300ms).
 */
type CanvasModule = typeof import("../shelf3d/ShelfCanvas");
let canvasModule: CanvasModule | null = null;
let canvasLoading: Promise<CanvasModule> | null = null;
const loadCanvas = () =>
  (canvasLoading ??= import("../shelf3d/ShelfCanvas").then((m) => (canvasModule = m)));

function useCanvasModule(enabled: boolean): CanvasModule | null {
  const [mod, setMod] = useState<CanvasModule | null>(canvasModule);
  useEffect(() => {
    if (!enabled || mod) return;
    let live = true;
    loadCanvas().then(
      (m) => live && setMod(m),
      () => {}, // a failed chunk load leaves the static fallback to the boundary below
    );
    return () => {
      live = false;
    };
  }, [enabled, mod]);
  return mod;
}

type Props = {
  /** Visible essays, newest issue first. */
  essays: Essay[];
  /** Best search match to bring to the centre when the list changes. */
  focusId?: string | null;
  /** The topic pill in use: changing it drops the other books off the shelf. */
  topic?: string | null;
  /** The header's read filter: only the books the visitor has read stay on the shelf. */
  readOnly?: boolean;
  /** Shown over the shelf when nothing matches (the other books are off the shelf, not gone). */
  emptyHint?: string;
  /** Drift Pause/Play, owned by the page so it survives an empty result. */
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
};

/** Glide to centre an opened / browsed book. */
const OPEN_GLIDE_MS = 800;
/**
 * The stage height; the engine frames the books to fill it (the tallest book under a headroom of
 * 13 % kept within 40-54 px, for the hover lift and a calm gap under the pills; the plank and lip
 * on a thin band below). The width term keeps phones at ~10-14 books across. The books keep the
 * size they had with an 11 % headroom (86 % of B, B the clamp below), so the stage is the books'
 * band plus that headroom: (B × 0.86 + head) / 0.97 (engine.ts: HEADROOM).
 */
const STAGE_BASE = "clamp(300px, min(48vh, 80vw), 500px)";
const STAGE_H = `clamp(calc((${STAGE_BASE} * 0.86 + 40px) / 0.97), calc(${STAGE_BASE} * 0.86 / 0.84), calc((${STAGE_BASE} * 0.86 + 54px) / 0.97))`;
const ALL_ISSUES = [...new Set(ALL_ESSAYS.map((e) => Math.max(...e.issues)))];

const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const DEBUG = params.has("debug");
const ALL_BY_ID = new Map(ALL_ESSAYS.map((e) => [e.id, e]));
const webglAvailable = () => !params.has("nowebgl") && typeof window !== "undefined" && "WebGL2RenderingContext" in window;
if (webglAvailable()) {
  void loadCanvas();
  void loadShelfFonts();
}

function readHashId(): string {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return "";
  }
}
function writeHash(id: string | null) {
  try {
    const { pathname, search } = window.location;
    const url = id ? `${pathname}${search}#${encodeURIComponent(id)}` : `${pathname}${search}`;
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* sandboxed history: the panel still works */
  }
}

const keyOf = (it: RowItem) => (it.kind === "book" ? it.essay.id : it.key);

// ------------------------------------------------------------------ a11y list

type ListProps = {
  items: RowItem[];
  stopKey: string | null;
  readSet: ReadonlySet<string>;
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus: (e: FocusEvent<HTMLDivElement>) => void;
  onBlur: (e: FocusEvent<HTMLDivElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * The shelf for keyboards and screen readers: a visually hidden list of real
 * buttons in shelf order (one roving tab stop). Focus is drawn on the 3D book
 * by a projected outline; the books themselves are pixels in a canvas.
 */
const A11yList = memo(function A11yList({ items, stopKey, readSet, listRef, onKeyDown, onFocus, onBlur, onClick }: ListProps) {
  return (
    <div ref={listRef} className="sr-only" onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} onClick={onClick}>
      {items.map((it) => {
        const key = keyOf(it);
        const tab = key === stopKey ? 0 : -1;
        return it.kind === "book" ? (
          <button
            key={key}
            type="button"
            data-key={key}
            data-essay-id={it.essay.id}
            data-read={readSet.has(it.essay.id) || undefined}
            tabIndex={tab}
            aria-label={`${it.essay.title} by ${it.essay.author}`}
            aria-controls="detail-panel"
          />
        ) : (
          <button
            key={key}
            type="button"
            data-key={key}
            data-issue={it.issue}
            tabIndex={tab}
            aria-label={`Issue #${it.issue}: ${it.count} ${it.count === 1 ? "read" : "reads"}. Jump to it`}
          />
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------- no-WebGL fallback

/** A plain, scrollable row of flat spines when WebGL isn't available. */
function FallbackShelf({ items, readSet, onOpen }: { items: RowItem[]; readSet: ReadonlySet<string>; onOpen: (id: string) => void }) {
  return (
    <div className="no-scrollbar absolute inset-x-0 bottom-[60px] flex items-end gap-[2px] overflow-x-auto px-4 pb-2 pt-10" data-fallback="">
      {items.map((it) =>
        it.kind === "book" ? (
          <button
            key={it.key}
            type="button"
            data-essay-id={it.essay.id}
            data-read={readSet.has(it.essay.id) || undefined}
            onClick={() => onOpen(it.essay.id)}
            aria-label={`${it.essay.title} by ${it.essay.author}`}
            aria-controls="detail-panel"
            className="shrink-0 overflow-hidden rounded-[2px] px-0.5 py-2 text-left font-serif text-[13px] leading-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            style={{
              width: it.essay.width,
              height: it.essay.height,
              background: bookStyle(it.essay).base,
              color: bookStyle(it.essay).ink,
              writingMode: "vertical-rl",
            }}
          >
            {it.essay.title}
          </button>
        ) : (
          <span
            key={it.key}
            aria-hidden="true"
            className="flex w-6 shrink-0 items-start justify-center rounded-[2px] pt-3 font-serif text-[10px] font-semibold"
            style={{ height: MARKER_H, background: MARKER_COLOUR, color: MARKER_INK }}
          >
            #{it.issue}
          </span>
        ),
      )}
    </div>
  );
}

class CanvasBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------- shelf

export function Shelf({ essays, focusId = null, topic = null, readOnly = false, emptyHint = "Try fewer words or another topic", paused, onPausedChange }: Props) {
  const reduced = usePrefersReducedMotion();
  const readSet = useReadSet();
  const row = useMemo(() => new Row(essays), [essays]);
  const [engine] = useState(() => new ShelfEngine3D(essays));
  const [stats] = useState(() => new FrameStats());
  const [info] = useState<CanvasInfo>(() => ({
    tier: "high",
    locked: false,
    scene: null,
    renderer: "",
    stepDowns: [],
    timings: { shelfMount: performance.now() },
  }));
  const [gl, setGl] = useState<"ok" | "lost" | "failed">(() => (webglAvailable() ? "ok" : "failed"));
  const fallback = gl === "failed";
  const canvasMod = useCanvasModule(!fallback);
  const ShelfCanvas = canvasMod?.default ?? null;
  // the 3D chunk failed to load (offline, blocked): the plain shelf
  useEffect(() => {
    if (fallback) return;
    loadCanvas().catch(() => {
      if (!reloadOnceOnChunkFailure("3D shelf")) setGl("failed");
    });
  }, [fallback]);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  // the 3D shelf hasn't come up in time: the plain shelf shows until it does (never a blank stage)
  const [stalled, setStalled] = useState(false);
  // the desk's book landed (the 3D one lies in the page's slot)
  const [deskLanded, setDeskLanded] = useState<string | null>(null);
  // a book flies to or from the desk: the caption's text fades out of its way
  const [deskFlying, setDeskFlying] = useState(false);
  const deskLandedRef = useRef<string | null>(null);
  // a shared link's read, opened once the 3D shelf is ready (its book pulls out then, fast)
  const pendingOpen = useRef<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  // the doodles kept on the 3D shelf by the engine: the brackets under the plank, the hover arrow
  const bracketL = useRef<HTMLDivElement>(null);
  const bracketR = useRef<HTMLDivElement>(null);
  const hoverMarkRef = useRef<HTMLDivElement>(null);
  // "this one!" round the book a Surprise landed on (stage px), while it pulls out
  const [spot, setSpot] = useState<{ key: number; left: number; top: number; width: number; height: number } | null>(null);
  const [spinning, setSpinning] = useState(false);
  // whether the row loops (and drifts): only when it is wider than the view, so no book is ever
  // on screen twice; a short row is centred and still (no Pause then)
  const [looping, setLooping] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  const firstLayout = useRef(true);
  const openEssay = openId ? (ALL_BY_ID.get(openId) ?? null) : null;

  // ---- the ground (books outside the topic / read filter)
  // a book belongs on the shelf when it's in the topic and (with the read filter) read; search only narrows the shelf
  const filterRef = useRef({ topic, readOnly, readSet });
  filterRef.current = { topic, readOnly, readSet };
  const frameRef = useRef<HTMLDivElement>(null);
  const shrinkTimer = useRef(0);

  // the roving tab stop of the hidden list
  const [stopKey, setStopKey] = useState<string | null>(null);
  const settingFocus = useRef(false);
  useEffect(() => {
    if (stopKey && row.kOfId(stopKey) !== undefined) return;
    const first = row.items.find((it) => it.kind === "book");
    setStopKey(first ? keyOf(first) : null);
  }, [row, stopKey]);

  const focusKey = useCallback((key: string) => {
    setStopKey(key);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (el && document.activeElement !== el) {
      settingFocus.current = true;
      el.focus({ preventScroll: true });
      settingFocus.current = false;
    }
  }, []);
  /** Keyboard highlight + DOM focus on a book. */
  const focusBook = useCallback(
    (v: number) => {
      engine.setHover(v, "kbd");
      focusKey(engine.idOf(v));
    },
    [engine, focusKey],
  );

  // ------------------------------------------------------------ open/close

  const setOpen = useCallback((id: string | null) => {
    openIdRef.current = id;
    setOpenId(id);
    writeHash(id);
  }, []);

  const openV = useCallback(
    (v: number, glide = true, fast = false) => {
      const item = engine.itemAt(v);
      if (!item || item.kind !== "book") return;
      const id = item.essay.id;
      const prev = openIdRef.current;
      if (prev === id) return;
      const ground = engine.ground;
      // Previous / Next (or another book while one is open): the desk's book returns, fast,
      // and the next one pulls out a moment later
      if (prev && ground) ground.fromDesk(prev, { fast: true, reduced });
      engine.select(v);
      engine.setPanelOpen(true);
      if (glide) engine.glideToCenter(v, OPEN_GLIDE_MS);
      setOpen(id);
      if (ground && readyRef.current && !fallback) ground.toDesk(id, { fast, delay: prev ? 250 : 0, reduced });
    },
    [engine, setOpen, reduced, fallback],
  );

  /**
   * Fold the desk and return the book. After a KEYBOARD close (Escape, or
   * Enter/Space on "Shelve it") focus goes back to the shelved book with its
   * keyboard highlight. A mouse close just lets go: no highlight, so the book
   * returns and the drift resumes.
   */
  const close = useCallback(
    (keyboard = false) => {
      const id = openIdRef.current;
      if (!id) return;
      const active = document.activeElement;
      const hadFocus = (active && panelRef.current?.contains(active)) ?? false;
      const v = engine.selected;
      engine.ground?.fromDesk(id, { reduced });
      engine.select(null);
      engine.setPanelOpen(false);
      setOpen(null);
      if (keyboard && hadFocus) {
        if (v !== null) focusBook(v);
        else if (stopKey) focusKey(stopKey);
      } else {
        if (hadFocus && active instanceof HTMLElement) active.blur();
        if (engine.hoverSource === "kbd") engine.setHover(null, null);
      }
    },
    [engine, setOpen, focusBook, focusKey, stopKey, reduced],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const v = engine.selected ?? engine.nearestBookToCenter();
      if (v === null) return;
      openV(engine.stepBook(v, dir));
    },
    [engine, openV],
  );

  const surprise = useCallback(() => {
    const pool = essays.filter((e) => e.id !== openIdRef.current);
    if (!pool.length) return;
    // prefer essays the spin can reach in ~2000–3500px; any essay otherwise
    const reachable = pool.filter((e) => engine.spinReachable(e.id));
    const from = reachable.length ? reachable : pool;
    const pick = from[Math.floor(Math.random() * from.length)];
    // fold any open desk while the shelf spins (the glide itself holds the drift); the
    // picked book pulls out once the spin has landed
    if (openIdRef.current) {
      engine.ground?.fromDesk(openIdRef.current, { reduced });
      engine.select(null);
      engine.setPanelOpen(false);
      setOpen(null);
    }
    setSpinning(true);
    engine.spinTo(pick.id, (v) => {
      setSpinning(false);
      // circle it where it landed, then let the doodle fade as it pulls out to the desk
      const r = engine.rectOf(v);
      if (r) setSpot({ key: performance.now(), left: r.left, top: r.top, width: r.width, height: r.height });
      openV(v, false);
    });
  }, [engine, essays, openV, setOpen, reduced]);
  useEffect(() => {
    if (!spot) return;
    const t = window.setTimeout(() => setSpot(null), reduced ? 1200 : 1400);
    return () => window.clearTimeout(t);
  }, [spot, reduced]);

  useEffect(() => {
    engine.onActivate = (v) => openV(v);
  }, [engine, openV]);

  // ---------------------------------------------------------------- engine

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || fallback) return;
    engine.focusRing = ringRef.current;
    engine.brackets = [bracketL.current, bracketR.current].filter((el): el is HTMLDivElement => !!el);
    engine.hoverMark = hoverMarkRef.current;
    engine.onLoopChange = setLooping;
    setLooping(engine.row.looping);
    const detach = engine.attach(stage);
    return () => {
      detach();
      engine.focusRing = null;
      engine.brackets = [];
      engine.onLoopChange = () => {};
      engine.hoverMark = null;
    };
  }, [engine, fallback]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame) return;
    // the canvas fills the stage; the shelf is framed in the top band (a taller stage = an open desk below it)
    const measure = () => {
      const r = stage.getBoundingClientRect();
      const fh = frame.getBoundingClientRect().height || r.height;
      if (r.width <= 0) return;
      if (r.width !== engine.view.w || fh !== engine.view.frameH) engine.resize(r.width, engine.view.h > 0 ? engine.view.h : fh, fh);
      // the canvas: the stage's own height (the shelf's band, the caption row and an open desk,
      // which the desk's book flies through and the fallers tumble past); it shrinks back only
      // once nothing can still be flying there. It never adds to the page: the wrapper clips it
      const want = Math.ceil(r.height);
      window.clearTimeout(shrinkTimer.current);
      if (want >= engine.view.h || engine.view.h <= 0) {
        if (want !== engine.view.h) engine.resize(r.width, want, fh);
      } else {
        shrinkTimer.current = window.setTimeout(() => {
          if (engine.view.h !== want && stageRef.current) engine.resize(engine.view.w, want, engine.view.frameH);
        }, 1600);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    ro.observe(frame);
    return () => {
      ro.disconnect();
      window.clearTimeout(shrinkTimer.current);
    };
  }, [engine, openId]);

  /**
   * A new list cancels any open, in flight or settled, through the one close
   * path: the desk folds, the book un-turns with its normal ease (or un-turns
   * as it falls), the glide stops, the hash and the keyboard highlight clear.
   */
  const closeForFilter = useCallback(() => {
    const id = openIdRef.current;
    if (!id && engine.selected === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    engine.stopMotion();
    // the desk's book heads back to its slot (the new list decides whether it falls instead)
    if (id) engine.ground?.fromDesk(id, { reduced });
    engine.select(null);
    engine.setPanelOpen(false);
    if (engine.hoverSource === "kbd") engine.setHover(null, null);
    setOpen(null);
  }, [engine, setOpen, reduced]);

  /** Hand a list to the engine and decide where the shelf starts. */
  const applyList = useCallback(
    (r: Row, first: boolean) => {
      engine.setRow(r);
      const has = (id: string) => r.kOfId(id) !== undefined;
      let target: string | null = null;
      let reopen = false;
      const hashId = first ? readHashId() : "";
      if (hashId && has(hashId)) {
        target = hashId;
        reopen = true;
      } else {
        engine.setPanelOpen(false);
        if (hashId) setOpen(null); // an unknown id in the URL
        if (focusId && has(focusId)) target = focusId;
      }
      const v = target ? engine.nearestV(target) : null;
      if (v !== null) {
        if (reopen) {
          engine.centerOn(v);
          if (readyRef.current || fallback) {
            engine.select(v);
            engine.setPanelOpen(true);
            setOpen(target);
            if (target) engine.ground?.toDesk(target, { fast: true, reduced });
          } else pendingOpen.current = target; // once the shelf is ready: the book pulls out, fast
        } else {
          // best search match: glide the last stretch to it (instant under reduced motion)
          engine.setPos(engine.centerTarget(v) - 420);
          engine.glideToCenter(v, OPEN_GLIDE_MS);
        }
      }
      engine.requestFrame();
    },
    [engine, focusId, setOpen, fallback, reduced],
  );

  // A new list. Books leaving because of the topic / read filter fall out of the stage, books
  // off the shelf that belong again rise into their slots, the rest close up. Otherwise (a
  // search): fade the shelf out, swap, fade back in (instant under reduced motion).
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      applyList(row, true);
      return;
    }
    closeForFilter();
    const ground = engine.ground;
    if (ground && readyRef.current && !fallback) {
      const { topic: t, readOnly: ro, readSet: rs } = filterRef.current;
      const belongs = (id: string) => {
        const e = ALL_BY_ID.get(id);
        return !!e && (!t || e.topics.includes(t)) && (!ro || rs.has(id));
      };
      const returning: string[] = [];
      for (const it of row.items) if (it.kind === "book" && ground.has(it.essay.id)) returning.push(it.essay.id);
      let falls = false;
      for (const it of engine.row.items) if (it.kind === "book" && row.kOfId(it.essay.id) === undefined && !belongs(it.essay.id)) falls = true;
      // books outside the topic / read filter that are on neither the shelf nor the ground (a
      // search had narrowed the shelf when the filter changed): they are off the shelf too, so
      // the ground is the same whether the search came before the pill or after it
      const missing: string[] = [];
      if (t || ro) for (const e of ALL_ESSAYS) if (!belongs(e.id) && row.kOfId(e.id) === undefined && engine.row.kOfId(e.id) === undefined && !ground.has(e.id)) missing.push(e.id);
      if (!returning.length && !falls && !missing.length) return applyListFaded();
      // (books leaving only because of a search just leave the shelf; they do not fall)
      const tl = performance.now();
      info.timings.listEffectAt = tl;
      const leaving = engine.morphTo(row, returning, reduced, ground.hiddenIds()).filter((L) => !belongs(L.id));
      ground.ground(missing);
      // (books new to the view are the ground's to fly in, like the returners)
      ground.apply(leaving, returning.concat(engine.entering), reduced);
      info.timings.listChangeMs = performance.now() - tl;
      return;
    }
    return applyListFaded();
    function applyListFaded() {
      if (reduced || !readyRef.current || fallback) {
        applyList(row, false);
        return;
      }
      setSwapping(true);
      const timer = window.setTimeout(() => {
        applyList(row, false);
        setSwapping(false);
      }, 150);
      return () => window.clearTimeout(timer);
    }
    // focusId arrives with the list it belongs to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  useEffect(() => {
    engine.setReduced(reduced);
  }, [engine, reduced]);

  useEffect(() => {
    engine.setUserPaused(paused);
  }, [engine, paused]);

  // If the shelf goes away (an empty search) while a read is open, the shared-link hash shouldn't linger.
  useEffect(
    () => () => {
      if (openIdRef.current) writeHash(null);
    },
    [],
  );

  // Escape closes; ←/→ browse while focus is in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !openIdRef.current) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && target && panelRef.current?.contains(target)) {
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, step]);

  // Shared links: #IR07-3 opens that essay; an empty hash closes.
  useEffect(() => {
    const onHash = () => {
      const id = readHashId();
      if (!id) {
        close();
        return;
      }
      if (id === openIdRef.current) return;
      const v = engine.nearestV(id);
      if (v !== null && engine.row.isBook(v)) openV(v);
      else close(); // unknown id: fold the desk and clear the hash
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [engine, close, openV]);

  // ------------------------------------------------------- hidden list events

  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const id = engine.kbdStep(e.key === "ArrowRight" ? 1 : -1);
      if (id) focusKey(id);
    },
    [engine, focusKey],
  );
  const onListFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (settingFocus.current) return;
      const btn = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-key]") : null;
      const key = btn?.dataset.key;
      if (!key) return;
      const from = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (!from || !listRef.current?.contains(from)) {
        // tabbing in: highlight the book at the centre of the view (or keep the current highlight)
        const id = engine.kbdEnter();
        if (id && id !== key) focusKey(id);
      } else {
        // a screen reader (or script) moved focus to a specific item
        engine.kbdFocus(key);
        setStopKey(key);
      }
    },
    [engine, focusKey],
  );
  const onListBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (next && listRef.current?.contains(next)) return;
      engine.kbdLeave();
    },
    [engine],
  );
  const onListClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const btn = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-key]") : null;
      const key = btn?.dataset.key;
      if (!key) return;
      // the highlighted copy if it's this item, else the nearest copy
      const h = engine.hoverSource === "kbd" ? engine.hovered : null;
      const v = h !== null && engine.idOf(h) === key ? h : engine.nearestV(key);
      if (v !== null) engine.activate(v);
    },
    [engine],
  );

  // ------------------------------------------------------------- debug hook

  useEffect(() => {
    if (!DEBUG) return;
    const stage = stageRef.current;
    const api = {
      engine,
      get tier() {
        return info.tier;
      },
      get ready() {
        return readyRef.current;
      },
      get fallback() {
        return fallback;
      },
      get hovered() {
        return engine.hovered === null ? null : engine.idOf(engine.hovered);
      },
      get selected() {
        return engine.selected === null ? null : engine.idOf(engine.selected);
      },
      get kbd() {
        return engine.hoverSource === "kbd" && engine.hovered !== null ? engine.idOf(engine.hovered) : null;
      },
      get pos() {
        return engine.pos;
      },
      get gliding() {
        return engine.isGliding;
      },
      get blankFrames() {
        return stats.blankFrames;
      },
      get frames() {
        return stats.frames;
      },
      get lateBakes() {
        return info.scene?.lateBakes ?? 0;
      },
      /** Visible books / bookends with their projected rects and spine centres (viewport px). */
      rects() {
        if (!stage) return [];
        const r = stage.getBoundingClientRect();
        const out: { id: string; kind: string; v: number; left: number; top: number; width: number; height: number; cx: number; cy: number; fx0: number; fx1: number; fy: number; s: number; w: number }[] = [];
        engine.forEachVisible((v, s) => {
          const q = engine.rectOf(v);
          const c = engine.spineCenterOf(v);
          const fe = engine.frontEdgeOf(v);
          if (!q || !c || !fe) return;
          if (c.x < 0 || c.x > r.width) return;
          out.push({
            s,
            w: engine.row.item(v).w,
            fx0: r.left + fe.x0,
            fx1: r.left + fe.x1,
            fy: r.top + fe.y,
            id: engine.idOf(v),
            kind: engine.row.item(v).kind,
            v,
            left: r.left + q.left,
            top: r.top + q.top,
            width: q.width,
            height: q.height,
            cx: r.left + c.x,
            cy: r.top + c.y,
          });
        });
        return out;
      },
      /** debug: where the time went: the slowest frame's parts, the list change, the ground's apply */
      timing() {
        const f = info.scene?.ground;
        return { parts: info.parts ?? null, listChangeMs: info.timings.listChangeMs ?? null, listEffectAt: info.timings.listEffectAt ?? null, applyMs: f?.stats.applyMs ?? null };
      },
      resetTiming() {
        if (info.parts) info.parts.total = 0;
      },
      /** A book's baked page (a data URL): "text", "title" or "back" (debug: proof of the page textures). */
      pageTexture(id: string, kind: "text" | "title" | "back" = "text") {
        return info.scene?.debugPage(id, kind) ?? null;
      },
      /** The desk's book: its flight stage, the page's slot and the book's projected rect (stage px). */
      desk() {
        const d = info.scene?.ground?.deskBook();
        if (!d || !stage) return null;
        const st = stage.getBoundingClientRect();
        const slotEl = panelRef.current?.querySelector('[data-testid="desk-slot"]');
        const sr = slotEl?.getBoundingClientRect();
        const slot = sr ? { left: sr.left - st.left, top: sr.top - st.top, width: sr.width, height: sr.height } : null;
        const rect = api.flightRects().find((o) => o.id === d.id) ?? null;
        return { id: d.id, state: d.state, stage: d.stage, alpha: +d.alpha.toFixed(2), hidden: engine.hidden.has(d.id), landed: deskLandedRef.current, slot, rect, pos: [Math.round(d.pos.x), Math.round(d.pos.y), Math.round(d.pos.z)] };
      },
      /** the 3D scene itself (debug: poke at lights, shadows, passes) */
      get scene() {
        return info.scene;
      },
      /** Hide the desk's book and its shadow (true) or show them again: to measure the desk around the book. */
      hideDeskBook(on: boolean) {
        if (info.scene) {
          info.scene.debugHideDesk = on;
          engine.requestFrame();
        }
      },
      /** The shelf band (stage px): where the wheel and drags belong to the shelf. */
      band: () => engine.shelfBand(),
      /** The plank's box in row space (what nothing may pass through). */
      plank() {
        return { yTop: 0, yBottom: -18, zBack: -204, zFront: 40 };
      },
      /** Every book flying to / from the desk or lying on it; and how the last one shelved met its slot. */
      flights() {
        const f = info.scene?.ground;
        return f ? { flights: f.flights(), lastShelved: f.lastShelved, hidden: [...engine.hidden] } : null;
      },
      /** The books off the shelf in motion (falling, flying back, on the desk): projected bounding boxes (viewport px), long-axis angle from horizontal (deg), pitch, row-space box. */
      flightRects() {
        const f = info.scene?.ground;
        const sc = info.scene;
        if (!f || !sc || !stage) return [];
        const r = stage.getBoundingClientRect();
        // (the canvas starts at the stage's top and is engine.view.w x view.h: it can be taller than the stage)
        const cw = engine.view.w || r.width;
        const ch = engine.view.h || r.height;
        const out: { bx: number; by: number; id: string; state: string; origin: string; coverDot: number; left: number; top: number; width: number; height: number; long: number; angle: number; pitch: number; open: boolean; coverA: number; fan: { a0: number; cover: number; a1: number; n: number } | null; z: number; ymin: number; ymax: number; zmin: number; zmax: number; inPlank: boolean; x: number; fx0: number; fx1: number; fy: number; s: number; rz: number; bottom: number; w: number }[] = [];
        for (const it of f.items.values()) {
          if (!it.render.length) continue;
          const c = it.wc.clone(); // (no three import here: the main chunk stays free of it)
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          // (the bottom-front edge of the block, projected: where the book stands)
          let fx0 = Infinity;
          let fx1 = -Infinity;
          let fy = 0;
          for (let pi = 0; pi < it.render.length; pi++) {
            const rp = it.render[pi];
            for (let k = 0; k < 8; k++) {
              c.set((k & 1 ? 1 : -1) * rp.half.x, (k & 2 ? 1 : -1) * rp.half.y, (k & 4 ? 1 : -1) * rp.half.z).applyQuaternion(rp.quat).add(rp.pos).project(sc.camera);
              const x = r.left + ((c.x + 1) / 2) * cw;
              const y = r.top + ((1 - c.y) / 2) * ch;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
              if (pi === 0 && !(k & 2) && k & 4) {
                fx0 = Math.min(fx0, x);
                fx1 = Math.max(fx1, x);
                fy += y / 2;
              }
            }
          }
          // the block's up vector's y, straight from its quaternion (a tipped book's pitch)
          const bq = it.parts[0].quat;
          const up = { y: 1 - 2 * (bq.x * bq.x + bq.z * bq.z) };
          const cover = it.parts.length > 1 ? it.parts[2].rel.q : null;
          const openAngle = cover ? Math.atan2(c.set(0, 0, -1).applyQuaternion(cover).x, -c.set(0, 0, -1).applyQuaternion(cover).z) : 0;
          // the box in row space (from the drawn parts, which carry the kinematic and played-back poses)
          let ymin = Infinity;
          let ymax = -Infinity;
          let zmin = Infinity;
          let zmax = -Infinity;
          // (a corner inside the plank's slab: the box passes through the wood)
          let inPlank = false;
          for (const pt of it.parts)
            for (let k = 0; k < 8; k++) {
              c.set((k & 1 ? 1 : -1) * pt.half.x, (k & 2 ? 1 : -1) * pt.half.y, (k & 4 ? 1 : -1) * pt.half.z).applyQuaternion(pt.quat).add(pt.pos);
              ymin = Math.min(ymin, c.y);
              ymax = Math.max(ymax, c.y);
              zmin = Math.min(zmin, c.z);
              zmax = Math.max(zmax, c.z);
              if (c.y > -18 + 1.5 && c.y < -1.5 && c.z > -204 + 2 && c.z < 40 - 2) inPlank = true;
            }
          const pitch = (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
          const arc = f.arcOf(it);
          // how the block's +x face (the front cover of a shut book) faces the camera: 1 = square on
          const ax = c.set(1, 0, 0).applyQuaternion(it.render[0].quat);
          const coverDot = ax.dot(sc.camera.position.clone().sub(it.render[0].pos).normalize());
          const bc = c.copy(it.render[0].pos).project(sc.camera);
          const bx = ((bc.x + 1) / 2) * cw;
          const by = ((1 - bc.y) / 2) * ch;
          out.push({ bx, by, id: it.id, state: it.state, origin: it.origin, coverDot: +coverDot.toFixed(3), left: minX - r.left, top: minY - r.top, width: maxX - minX, height: maxY - minY, long: Math.max(maxX - minX, maxY - minY), angle: (Math.asin(Math.min(1, Math.abs(up.y))) * 180) / Math.PI, pitch, open: openAngle > 0.3, coverA: openAngle, fan: f.fanInfo(it), z: it.parts[0].pos.z, ymin, ymax, zmin, zmax, inPlank, x: it.parts[0].pos.x, fx0: fx0 - r.left, fx1: fx1 - r.left, fy: fy - r.top, s: arc.s, rz: arc.z, bottom: arc.bottom, w: it.parts[0].half.x * 2 });
        }
        return out;
      },
      /** The ground: counts by state, physics, the simulation's stats, the join / clamp logs. */
      ground: () => {
        const f = info.scene?.ground;
        if (!f) return null;
        const states: Record<string, number> = {};
        for (const it of f.items.values()) states[it.state] = (states[it.state] ?? 0) + 1;
        return { count: f.count, items: f.items.size, physics: f.physicsReady, stepMs: f.stepMs, maxStepMs: f.maxStepMs, hinged: f.hingedCount, states, openings: f.openings(), sim: f.stats, job: f.lastJob, joins: f.joinLog, clamps: f.clampLog, stalls: f.stalls };
      },
      /** the 3D camera (position, rotation) and the shelf framing it should match at the top */
      camera: () => {
        const c = info.scene?.camera;
        const v = engine.view;
        return c ? { pos: c.position.toArray(), rot: [c.rotation.x, c.rotation.y, c.rotation.z], shelf: [0, v.E, v.d] } : null;
      },
      stats: (last?: number) => stats.summary(last),
      intervals: (last?: number) => stats.intervals(last),
      resetStats: () => {
        stats.reset();
        info.scene?.ground?.resetStepStats();
      },
      info: () => ({
        tier: info.tier,
        locked: info.locked,
        renderer: info.renderer,
        stepDowns: [...info.stepDowns],
        dpr: window.devicePixelRatio,
        textureMB: info.scene ? Math.round(info.scene.textureBytes() / 1048576) : 0,
        pages: info.scene?.pageCounts() ?? null,
        bake: info.scene?.bakeStats ?? null,
        timings: { ...info.timings },
      }),
    };
    (window as unknown as { __shelf?: typeof api }).__shelf = api;
    return () => {
      delete (window as unknown as { __shelf?: typeof api }).__shelf;
    };
  }, [engine, stats, info, fallback]);

  // (the canvas captures onReady once; the work it triggers reads the latest closures through this ref)
  const onReadyActions = useRef<() => void>(() => {});
  onReadyActions.current = () => {
    const ground = engine.ground;
    if (ground) {
      ground.deskTarget = deskTarget;
      ground.onDesk = (id, on) => {
        deskLandedRef.current = on ? id : null;
        setDeskLanded(on ? id : null);
      };
      ground.onFlying = (flying) => setDeskFlying(flying);
    }
    const id = pendingOpen.current;
    if (id) {
      pendingOpen.current = null;
      const v = engine.nearestV(id);
      if (v !== null && engine.row.isBook(v)) openV(v, false, true);
    } else if (openIdRef.current && ground) {
      // the plain shelf opened a desk while the 3D one was coming up: its book lifts now
      ground.toDesk(openIdRef.current, { fast: true, reduced });
    }
  };
  const onReady = useCallback(() => {
    readyRef.current = true;
    setReady(true);
    onReadyActions.current();
  }, []);
  /** The desk's book slot (stage px), for the canvas to land the book in. */
  const deskTarget = useCallback((): DeskRect | null => {
    const slot = panelRef.current?.querySelector<HTMLElement>('[data-testid="desk-slot"]');
    const stage = stageRef.current;
    if (!slot || !stage) return null;
    const r = slot.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return { cx: r.left + r.width / 2 - st.left, cy: r.top + r.height / 2 - st.top, w: r.width, h: r.height };
  }, []);
  // the never-blank watchdog: 4 s after mount without a ready 3D shelf, the plain shelf shows
  // (and a shared link's desk opens there) until the 3D one arrives
  useEffect(() => {
    if (fallback || ready) return;
    const t = window.setTimeout(() => {
      if (readyRef.current) return;
      const marks = Object.entries(info.timings).sort((a, b) => a[1] - b[1]);
      const last = marks.length ? marks[marks.length - 1][0] : "mount";
      console.warn(`Interesting Reads: the 3D shelf is not ready 4 s after mount (last stage reached: ${last}); showing the plain shelf until it is.`);
      setStalled(true);
      const id = pendingOpen.current;
      if (id) {
        pendingOpen.current = null;
        engine.setPanelOpen(true);
        setOpen(id);
      }
    }, 4000);
    return () => window.clearTimeout(t);
  }, [fallback, ready, info, engine, setOpen]);
  const onLost = useCallback((lost: boolean) => setGl(lost ? "lost" : "ok"), []);
  const onFail = useCallback(() => setGl("failed"), []);

  // a lost context that never comes back -> the plain shelf
  useEffect(() => {
    if (gl !== "lost") return;
    const t = window.setTimeout(() => setGl("failed"), 2500);
    return () => window.clearTimeout(t);
  }, [gl]);

  const openById = useCallback(
    (id: string) => {
      const v = engine.nearestV(id);
      if (v !== null) openV(v, false);
    },
    [engine, openV],
  );

  // Surprise me lives in the header (next to the reads counter) via a portal; inline here
  // only if the page has no slot for it
  const surpriseButton = (
  <button
    type="button"
    data-testid="surprise-me"
    aria-label="Surprise me: spin to a random read"
    data-spinning={spinning || undefined}
    onClick={surprise}
    // (cream while it spins)
    className="flex h-9 items-center gap-2 rounded-full border border-foreground/55 px-3.5 font-sans text-[12px] uppercase tracking-[0.16em] text-foreground/90 transition-colors hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[spinning]:border-cream data-[spinning]:bg-cream data-[spinning]:text-background sm:px-4"
  >
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 min-[380px]:hidden"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 4.5h2.2c1.4 0 2.2.7 3 2l1.6 3c.8 1.3 1.6 2 3 2H14M12 9.6l2 1.9-2 1.9M2 11.5h2.2c.9 0 1.5-.3 2.1-.9M9.5 5.4c.6-.6 1.2-.9 2.1-.9H14M12 2.6l2 1.9-2 1.9" />
    </svg>
    <span className="hidden min-[380px]:inline">Surprise me</span>
  </button>
  );
  const [surpriseSlot, setSurpriseSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSurpriseSlot(document.getElementById("surprise-slot")), []);

  const captionRow = (
        <div className="relative mx-auto flex w-full max-w-5xl items-start gap-4 px-4 sm:px-8">
          <ShelfCaption engine={engine} />
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            {/* Pause/Play stays for keyboard and screen-reader visitors (WCAG 2.2.2) but is only
                drawn while it has keyboard focus; the drift already stops under the pointer */}
            {looping && !fallback ? (
              <button
                type="button"
                data-testid="drift-toggle"
                onClick={() => onPausedChange(!paused)}
                aria-label={paused ? "Play shelf motion" : "Pause shelf motion"}
                aria-pressed={paused}
                className="sr-only flex h-9 items-center gap-2 rounded-full border border-foreground/55 px-3 font-sans text-[12px] uppercase tracking-[0.16em] text-foreground/90 transition-colors hover:border-foreground hover:text-foreground focus-visible:not-sr-only focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-4"
              >
                {paused ? (
                  <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 sm:hidden" fill="currentColor">
                    <path d="M3 1.8v8.4L10.2 6z" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 sm:hidden" fill="currentColor">
                    <path d="M2.5 1.8h2.6v8.4H2.5zM6.9 1.8h2.6v8.4H6.9z" />
                  </svg>
                )}
                <span className="hidden sm:inline">{paused ? "Play" : "Pause"}</span>
              </button>
            ) : null}
            {surpriseSlot ? null : surpriseButton}
          </div>
        </div>
  );

  // ---------------------------------------------------------------- render

  // Under the shelf band, in the flow: the caption row and controls (above the canvas, so
  // falling books pass behind them) and the desk, which unfolds under the caption row
  const belowShelf = (
    <>
      <div className="relative z-10 pb-2" data-flying={deskFlying || undefined}>
        {captionRow}
        {surpriseSlot ? createPortal(surpriseButton, surpriseSlot) : null}
      </div>
      <div className="desk-area relative">
          <DetailPanel
            ref={panelRef}
            essay={openEssay}
            read={openEssay ? readSet.has(openEssay.id) : false}
            reduced={reduced}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onClose={(keyboard) => close(keyboard)}
            onSetRead={setRead}
            bookInDom={fallback || !ready}
            landed={deskLanded}
          />
      </div>
    </>
  );

  return (
    // (pulled up over the space under the pills, which holds only the filter's status line: the
    // canvas is transparent there, the line shows through, and the books sit close under the pills)
    <section aria-label="Bookshelf" className="relative -mt-[44px]">
      <div className="relative">
        <div>
          <div
            role="group"
            aria-roledescription="bookshelf"
            aria-label={`${essays.length} reads, newest issue first`}
            aria-describedby="shelf-help"
            className="relative"
            data-testid="shelf"
            data-ready={ready || undefined}
            data-tier={DEBUG ? info.tier : undefined}
          >
            <div
              ref={stageRef}
              // (the engine sets the cursor: a pointing hand over a book, the closed hand while held / dragged)
              className="shelf-stage relative select-none"
              style={fallback ? { height: STAGE_H } : undefined}
            >
              {/* the shelf's own band: the camera frames the shelf in it; the caption row and an open
                  desk follow it in the flow, all over the one canvas */}
              <div ref={frameRef} aria-hidden="true" className={fallback ? "pointer-events-none absolute inset-x-0 top-0" : "pointer-events-none"} style={{ height: STAGE_H }} />
              {/* the shelf for keyboards and screen readers lives at the top of the stage, so focusing
                  it never scrolls the page down to the desk */}
              {fallback ? null : (
                <A11yList
                  items={row.items}
                  stopKey={stopKey}
                  readSet={readSet}
                  listRef={listRef}
                  onKeyDown={onListKeyDown}
                  onFocus={onListFocus}
                  onBlur={onListBlur}
                  onClick={onListClick}
                />
              )}
              {fallback ? (
                <FallbackShelf items={row.items} readSet={readSet} onOpen={openById} />
              ) : (
                <>
                  {stalled && !ready ? <FallbackShelf items={row.items} readSet={readSet} onOpen={openById} /> : null}
                <div className="shelf-fade absolute inset-0 z-[1]" data-ready={(ready && gl === "ok") || undefined} data-swap={swapping || undefined}>
                  <CanvasBoundary onFail={onFail}>
                    {ShelfCanvas ? (
                      <ShelfCanvas
                        frameH={STAGE_H}
                        engine={engine}
                        all={ALL_ESSAYS}
                        issues={ALL_ISSUES}
                        readIds={readSet}
                        stats={stats}
                        info={info}
                        onReady={onReady}
                        onLost={onLost}
                      />
                    ) : null}
                  </CanvasBoundary>
                </div>
                </>
              )}
              <div ref={ringRef} aria-hidden="true" className="shelf-focus-ring" />
              {fallback ? null : (
                <>
                  {/* under the canvas (books falling past cover them), placed by the engine */}
                  <div ref={bracketL} aria-hidden="true" className="shelf-doodle text-doodle">
                    <Bracket />
                  </div>
                  <div ref={bracketR} aria-hidden="true" className="shelf-doodle text-doodle">
                    <Bracket mirror />
                  </div>
                  <div ref={hoverMarkRef} aria-hidden="true" className="shelf-doodle shelf-hover-mark text-doodle/85">
                    <UpArrow className="h-[22px] w-[15px]" />
                  </div>
                  {spot ? (
                    <div
                      key={spot.key}
                      aria-hidden="true"
                      data-testid="surprise-doodle"
                      className="shelf-spot text-doodle"
                      style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
                    >
                      <ThisOne w={spot.width} h={spot.height} />
                    </div>
                  ) : null}
                </>
              )}
              {essays.length === 0 ? (
                <div data-testid="shelf-empty" className="absolute inset-x-0 top-0 z-10 flex flex-col items-center justify-center px-6 text-center" style={{ height: STAGE_H }}>
                  <p className="font-display text-4xl font-semibold text-foreground/85">No reads match</p>
                  <p className="mt-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{emptyHint}</p>
                </div>
              ) : null}
              {fallback ? null : belowShelf}
            </div>
          </div>
          {fallback ? belowShelf : null}
        </div>
      </div>
      <p id="shelf-help" className="sr-only">
        Use the left and right arrow keys to browse the shelf and Enter to open a read.
      </p>

    </section>
  );
}
