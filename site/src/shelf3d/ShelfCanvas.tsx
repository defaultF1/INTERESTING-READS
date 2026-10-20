import { Canvas, addEffect, useFrame, useThree, type CanvasProps } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Essay } from "../data/essays";
import { loadShelfFonts, shelfFontsWithin } from "./fonts";
import type { ShelfEngine3D } from "./engine";
import { GroundController } from "./ground";
import { ShelfScene, type Tier } from "./scene";
import type { FrameStats } from "./stats";

/**
 * The WebGL host (code-split: three + R3F load after the header and search
 * have painted). R3F runs a demand-driven loop: the engine asks for frames
 * while anything moves, and the shelf renders nothing when it's still.
 *
 * Adaptive quality: HIGH (shadow map, MSAA, DPR ≤ 2) / MEDIUM (blob shadows,
 * MSAA, DPR ≤ 1.5; ≤ 2 on phones, where crisp titles matter more) /
 * LOW (DPR 1, no MSAA, no environment reflections). MSAA is fixed when the
 * context is created, so a runtime step-down keeps it. The first tier comes
 * from a quick device check; it steps down automatically when frames run slow.
 */

export type CanvasInfo = {
  tier: Tier;
  locked: boolean;
  scene: ShelfScene | null;
  renderer: string;
  stepDowns: string[];
  /** startup marks, ms since navigation start (?debug) */
  timings: Record<string, number>;
  /** the slowest frame's parts (ms) since the last reset (?debug) */
  parts?: { engine: number; ground: number; update: number; render: number; total: number; at: number };
};

/** When this chunk finished loading. */
const T_MODULE = performance.now();

type Props = {
  /** the shelf band's CSS height (the canvas element grows past it when the page needs more) */
  frameH: string;
  engine: ShelfEngine3D;
  all: Essay[];
  issues: number[];
  readIds: ReadonlySet<string>;
  stats: FrameStats;
  info: CanvasInfo;
  onReady: () => void;
  onLost: (lost: boolean) => void;
};

const MAX_DPR: Record<Tier, number> = { high: 2, medium: 1.5, low: 1 };
/** Phones keep text crisp at MEDIUM: DPR 2 (a 1.5× canvas upscaled to 3× looks soft); slow GPUs still step down to LOW. */
const MOBILE_MEDIUM_DPR = 2;
const NEXT: Record<Tier, Tier> = { high: "medium", medium: "low", low: "low" };
/** Step down when the median frame interval over a 90-frame window exceeds this (≈ 45 fps). */
const SLOW_MS = 22;

const noEvents: CanvasProps["events"] = () => ({ enabled: false, priority: 0 });

function pickTier(mobile: boolean): { tier: Tier; locked: boolean } {
  const forced = new URLSearchParams(window.location.search).get("tier");
  if (forced === "high" || forced === "medium" || forced === "low") return { tier: forced, locked: true };
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory ?? 8;
  if (mobile) return { tier: cores >= 6 && mem >= 4 ? "medium" : "low", locked: false };
  return { tier: cores >= 4 && mem >= 4 ? "high" : "medium", locked: false };
}

// the rAF timestamp of the frame being rendered (smoother than performance.now())
let rafTs = 0;
addEffect((ts) => {
  rafTs = ts;
});

function Driver({
  engine,
  all,
  issues,
  readIds,
  stats,
  info,
  tier,
  locked,
  onSlow,
  onReady,
  onLost,
}: Props & { tier: Tier; locked: boolean; onSlow: (why: string) => void }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const shelfRef = useRef<ShelfScene | null>(null);
  const groundRef = useRef<GroundController | null>(null);
  const evalAt = useRef(0);

  useEffect(() => {
    const T = info.timings;
    T.module = T_MODULE;
    T.renderer = performance.now();
    // (a transparent canvas: cleared to nothing, so the page shows through; set here as well as
    // by `alpha`, which Safari has been known to composite as opaque black)
    gl.setClearColor(0x000000, 0);
    gl.setClearAlpha(0);
    const shelf = new ShelfScene(engine, gl);
    T.scene = performance.now();
    shelfRef.current = shelf;
    info.scene = shelf;
    shelf.attachTo(scene);
    shelf.applyTier(tier, true);
    shelf.prepare(all, issues);
    T.prepare = performance.now();
    engine.requestFrame = () => invalidate();
    engine.onResize = () => {
      shelf.resize(engine.view.w, engine.view.h);
      invalidate();
    };
    if (engine.view.w > 0) shelf.resize(engine.view.w, engine.view.h);
    // the ground: the books off the shelf (falling, flying back) and the one on the desk
    const ground = new GroundController(engine, new Map(all.map((e) => [e.id, e])));
    groundRef.current = ground;
    shelf.ground = ground;
    engine.ground = ground;
    ground.hingedLimit = tier === "high" ? 40 : 12;
    const ndc = new THREE.Vector3();
    ground.inView = (p) => {
      ndc.copy(p).project(shelf.camera);
      return Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05 && ndc.z < 1;
    };
    // a book's cover is made ready before it is shown large: at the click (now), and ahead of
    // it for the hovered book, so the pull-out never turns a blank face toward the reader
    ground.prepareCover = (id) => shelf.prepareCover(id, true);
    ground.coverReady = (id) => shelf.coverReady(id);
    const unsubHover = engine.subscribeHover(() => {
      const snap = engine.getHoverSnapshot();
      if (snap.gi !== null && engine.row.isBook(snap.gi)) shelf.prepareCover(engine.idOf(snap.gi));
    });
    try {
      const ctx = gl.getContext();
      const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
      info.renderer = String(ctx.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : ctx.RENDERER));
      if (!locked && /swiftshader|llvmpipe|softpipe|basic render/i.test(info.renderer)) onSlow(`software renderer (${info.renderer})`);
    } catch {
      /* no renderer string */
    }
    let alive = true;
    // in parallel: shader compiles (async), the fonts (started at page load), then the first view's faces
    const compiled = shelf.compile(scene).then(() => {
      T.compiled = performance.now();
    });
    void shelfFontsWithin(1200)
      .then((fontsOk) => {
        T.fonts = performance.now();
        // a slow network: bake now with fallbacks, repaint when the real faces arrive
        if (!fontsOk) void loadShelfFonts().then((ok) => ok && alive && shelf.rebakeAll());
        return alive ? shelf.bake() : undefined;
      })
      .then(() => {
        T.bake = performance.now();
        return compiled;
      })
      .then(() => {
        if (!alive) return;
        engine.frame(performance.now());
        shelf.update();
        shelf.warmup(scene); // uploads the atlases (programs are compiled)
        T.warmup = performance.now();
        onReady();
        engine.startEntrance();
        invalidate();
        // prefetch the physics and warm the materials at idle, so the first pill click has
        // no delay and no hitch
        const warm = () => {
          if (!alive) return;
          shelf.warmGround(scene);
          // (the covers of the books in view, about a screen either side, baked at idle too)
          engine.forEachVisible((v) => {
            if (engine.row.isBook(v)) shelf.prepareCover(engine.idOf(v));
          });
          void ground.loadPhysics();
        };
        window.setTimeout(() => {
          if (!alive) return;
          if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(warm, { timeout: 2000 });
          else warm();
        }, 1200);
      });
    const canvas = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault(); // lets the browser restore the context
      onLost(true);
    };
    const restored = () => {
      shelf.restore();
      onLost(false);
      invalidate();
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      alive = false;
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      engine.requestFrame = () => {};
      engine.onResize = () => {};
      unsubHover();
      ground.dispose();
      if (engine.ground === ground) engine.ground = null;
      groundRef.current = null;
      shelf.dispose();
      shelfRef.current = null;
      info.scene = null;
    };
    // the scene is built once per renderer; later prop changes are pushed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, gl, scene, invalidate]);

  useEffect(() => {
    shelfRef.current?.setRead(readIds);
    invalidate();
  }, [readIds, invalidate]);

  useEffect(() => {
    shelfRef.current?.applyTier(tier);
    if (groundRef.current) groundRef.current.hingedLimit = tier === "high" ? 40 : 12;
    evalAt.current = stats.count + 120; // let the new tier settle before judging it
    invalidate();
  }, [tier, stats, invalidate]);

  useFrame(() => {
    const shelf = shelfRef.current;
    if (!shelf || !shelf.ready) return; // nothing to show yet (and no stray shader compiles)
    const t0 = performance.now();
    const now = rafTs || t0;
    // the canvas takes its size here, right before the render: a resized drawing buffer is
    // blank until drawn, and this way the blank never reaches the screen (the page grows the
    // stage when books fall or a desk opens)
    const v = engine.view;
    const el = gl.domElement;
    if (v.w > 0 && v.h > 0 && (el.width !== Math.round(v.w * gl.getPixelRatio()) || el.height !== Math.round(v.h * gl.getPixelRatio()))) {
      gl.setSize(v.w, v.h, false);
      el.style.width = `${v.w}px`;
      el.style.height = `${v.h}px`;
      shelf.resize(v.w, v.h);
    }
    let active = engine.frame(now);
    const t1 = performance.now();
    if (groundRef.current?.update(now)) active = true;
    const t2 = performance.now();
    const blank = shelf.update();
    const t3 = performance.now();
    gl.render(scene, shelf.camera);
    const t4 = performance.now();
    // (debug: the slowest frame's parts since the last reset)
    const P = (info.parts ??= { engine: 0, ground: 0, update: 0, render: 0, total: 0, at: 0 });
    if (t4 - t0 > P.total) {
      P.total = t4 - t0;
      P.engine = t1 - t0;
      P.ground = t2 - t1;
      P.update = t3 - t2;
      P.render = t4 - t3;
      P.at = t0;
    }
    if (shelf.ready) stats.record(now, performance.now() - t0, blank);
    if (shelf.ready && !info.timings.visible) info.timings.visible = performance.now();
    if (active) invalidate();
    else stats.idle();
    // quick benchmark / auto step-down: judge each 90-frame window of motion
    if (!locked && tier !== "low" && shelf.ready && stats.count >= evalAt.current + 90) {
      evalAt.current = stats.count;
      const s = stats.summary(90);
      if (s.median > SLOW_MS) onSlow(`median ${s.median.toFixed(1)}ms on ${tier}`);
    }
  }, 1);

  return null;
}

export default function ShelfCanvas(props: Props) {
  const { frameH } = props;
  const [mobile] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const [start] = useState(() => pickTier(mobile));
  const [tier, setTier] = useState<Tier>(start.tier);
  const { info } = props;
  info.tier = tier;
  info.locked = start.locked;
  const cap = mobile && tier === "medium" ? MOBILE_MEDIUM_DPR : MAX_DPR[tier];
  const dpr = Math.min(window.devicePixelRatio || 1, cap);

  const onSlow = (why: string) => {
    setTier((t) => {
      if (t === "low") return t;
      info.stepDowns.push(`${t} -> ${NEXT[t]}: ${why}`);
      return NEXT[t];
    });
  };

  return (
    <Canvas
        onCreated={() => (info.timings.created = performance.now())}
        aria-hidden="true"
        // (the frame's band only: the canvas itself grows past it inside the frame loop above)
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: frameH, overflow: "visible", pointerEvents: "none" }}
        frameloop="demand"
        dpr={dpr}
        events={noEvents}
        resize={{ scroll: false, debounce: 0 }}
        gl={{
          antialias: start.tier !== "low",
          alpha: true,
          stencil: false,
          powerPreference: "high-performance",
          toneMapping: THREE.NeutralToneMapping,
          toneMappingExposure: 1,
        }}
      >
        <Driver {...props} tier={tier} locked={start.locked} onSlow={onSlow} />
      </Canvas>
  );
}
