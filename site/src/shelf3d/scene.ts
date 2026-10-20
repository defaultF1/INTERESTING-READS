import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Essay } from "../data/essays";
import { COVER_W } from "../components/bookFaces";
import { ribbonColour } from "../lib/essayMeta";
import { MARKER_COLOUR, bookStyle } from "../lib/bookStyle";
import {
  AtlasPacker,
  LABEL_H,
  LABEL_W,
  SHELF_COLOUR,
  blobTexture,
  drawCover,
  drawBackCover,
  drawCoverPlain,
  drawInnerPage,
  drawPlate,
  drawTextPage,
  drawTitlePage,
  spineStats,
  fastLoop,
  drawSpine,
  idleLoop,
  lipTexture,
  uvOf,
  wallShadowTexture,
  type Slot,
} from "./bake";
import type { ShelfEngine3D } from "./engine";
import { type GroundController, type RenderPart } from "./ground";
import { BOOK_DEPTH, LIP, MARKER_D, MARKER_H, MARKER_W, PLANK_FRONT } from "./row";

/**
 * The WebGL shelf (three.js, imperative; R3F only hosts the canvas and the
 * demand-driven loop). A handful of instanced draw calls render every book
 * near the view:
 *   body   — back board, page-block top with real page lines, fore-edge
 *   spines — one InstancedMesh per atlas page (per-instance uv rect + material)
 *   covers — the front boards, same scheme (low density; a turned book gets a
 *            hi-res cover of its own)
 *   ribbons, contact blobs, the issue markers (short mustard books, "#N" labels)
 * The shelf (a slim matte charcoal plank traced with a hand-drawn marker line; its two
 * doodled brackets are DOM, placed by the engine) and the shadows the books cast follow the drum curve; there
 * is no wall: the canvas is transparent and the black page shows through. One warm key
 * light from the top-left, a soft hemisphere fill and a PMREM'd RoomEnvironment.
 */

export type Tier = "high" | "medium" | "low";

const CAPACITY = 720; // max books drawn: the shelf near the view (phones ~45 .. 2560px ~150) + the books falling or flying
const LATE_BAKE_MS = 5; // synchronous face bakes allowed per frame
const DESK_SHADOW_FEATHER = 12; // the desk book's shadow: its soft edge (world units, ~15-18 px)
const DESK_SHADOW_OPACITY = 0.35;
const PANEL_BACK = BOOK_DEPTH + 26; // the (invisible) shadow-catching plane behind the books
const PANEL_H = 520; // runs up past the top of the stage
const PLATE_RHO = 3;
/** an issue marker's depth: a short book's (a little shallower than the essays) */
const SLAB_D = MARKER_D;
/** every jacket is matte paper */
const MATTE = 0.82;
/** how much darker a shelved book's side boards are drawn (0..1) */
const SIDE_SHADE = 0.78;
/** World units beyond the stage edge (s = sMax) that still count as on screen. */
const ON_SCREEN_MARGIN = 60;
/** Above this speed (screen px/s) new cover images wait (a spin or fling doesn't need them). */
const FAST = 700;
const HI_SLOTS = 3;

/** drawn: something is in the atlas; plain: only the quick stand-in (covers) */
type Face = { slot: Slot; uv: Float32Array; drawn: boolean; plain?: boolean };
type BookInfo = {
  e: Essay;
  spine: Face;
  cover: Face;
  col: Float32Array;
  band: Float32Array;
  rib: THREE.Color;
  mat: Float32Array; // roughness, roundness, 0
  size: Float32Array; // w, h, D, hardcover
  img: HTMLImageElement | null | undefined; // undefined: not requested, null: loading / failed
};
/** A slot of the inner-page atlas (a page of text, a title page, plain paper). */
type InnerSlot = { rect: Slot; uv: Float32Array; id: string | null; painted: string | null; withImg: boolean; used: number; queued: boolean };
type Hi = {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  id: string | null;
  painted: string | null;
  paintedWithImg: boolean;
  queued: boolean;
};

const ric: (cb: () => void, timeout: number) => void =
  typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
    ? (cb, timeout) => window.requestIdleCallback(cb, { timeout })
    : (cb) => window.setTimeout(cb, 16);

const _ndc = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

function lin(hex: string): Float32Array {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  return new Float32Array([c.r, c.g, c.b]);
}

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, attrs: Record<string, number>, cap = CAPACITY) {
  const g = geo.clone();
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  const m = new THREE.InstancedMesh(g, mat, cap);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.count = 0;
  return m;
}

// --- unit geometries: x ∈ [-.5,.5], y ∈ [0,1], z ∈ [-1,0] (spine face at z = 0) ---

function spineGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
}
/** The front board, on the book's local +x side; u runs hinge -> fore-edge. */
function coverGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateY(Math.PI / 2);
  g.translate(0.5, 0.5, -0.5);
  return g;
}
/** page-block top and tail, fore-edge (-z); attribute faceId 1/2 (the boards are atlas planes) */
function bodyGeometry() {
  const pos: number[] = [];
  const nor: number[] = [];
  const face: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], f: number) => {
    const o = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) {
      nor.push(...n);
      face.push(f);
    }
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([-0.5, 1, 0], [0.5, 1, 0], [0.5, 1, -1], [-0.5, 1, -1], [0, 1, 0], 1);
  quad([-0.5, 0, -1], [0.5, 0, -1], [0.5, 0, 0], [-0.5, 0, 0], [0, -1, 0], 1); // the tail (a tumbling book shows it)
  quad([0.5, 0, -1], [-0.5, 0, -1], [-0.5, 1, -1], [0.5, 1, -1], [0, 0, -1], 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("faceId", new THREE.Float32BufferAttribute(face, 1));
  g.setIndex(idx);
  return g;
}
/** A bookmark ribbon with a notched tail (unit square, tail at y = 0). */
/** The back board, on the book's local -x side; u runs fore-edge -> hinge, so its print reads from behind. */
function backGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateY(-Math.PI / 2);
  g.translate(-0.5, 0.5, -0.5);
  return g;
}
function ribbonGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 1);
  s.lineTo(0.5, 1);
  s.lineTo(0.5, 0);
  s.lineTo(0, 0.2);
  s.lineTo(-0.5, 0);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}
function boxGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, -0.5);
  return g;
}

// --- materials -----------------------------------------------------------------

/** Atlas-mapped faces: per-instance uv rect (iUv) and material (iMat: roughness, roundness). */
function atlasMaterial(map: THREE.Texture, key: string, opts: { metal?: number; rough?: number; tint?: number } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map,
    color: new THREE.Color(opts.tint ?? 1, opts.tint ?? 1, opts.tint ?? 1),
    roughness: opts.rough ?? 0.6,
    metalness: opts.metal ?? 0,
    envMapIntensity: 0.55,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = `attribute vec4 iUv;\nattribute vec3 iMat;\nvarying vec3 vMat;\nvarying float vLx;\nvarying vec3 vTanX;\n${sh.vertexShader}`
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = iUv.xy + vec2(uv.x, 1.0 - uv.y) * iUv.zw;
#endif`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  vLx = position.x * 2.0;
  vMat = iMat;
  vTanX = normalize(normalMatrix * (mat3(instanceMatrix) * vec3(1.0, 0.0, 0.0)));`,
      );
    sh.fragmentShader = `varying vec3 vMat;\nvarying float vLx;\nvarying vec3 vTanX;\n${sh.fragmentShader}`
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
  diffuseColor.rgb *= 1.0 - vMat.z; // (a book's side boards, seen past its neighbours on the shelf: in shade)`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
  roughnessFactor = vMat.x > 0.0 ? vMat.x : roughnessFactor;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
  // a gently rounded spine: tilt the normal across its width
  normal = normalize(normal + vTanX * (vLx * vMat.y));`,
      );
  };
  // every atlas page shares one program (the page is just a texture uniform)
  void key;
  mat.customProgramCacheKey = () => "atlas";
  return mat;
}

/** Body: the back board in the book's colour; page-block top and fore-edge with real page lines. */
function bodyMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = `attribute float faceId;\nattribute vec3 iColor;\nattribute vec3 iBand;\nattribute vec4 iSize;\nvarying float vFace;\nvarying vec3 vCol;\nvarying vec3 vBandC;\nvarying vec4 vSize;\nvarying vec3 vPos;\n${sh.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
  vFace = faceId; vCol = iColor; vBandC = iBand; vSize = iSize; vPos = position;`,
    );
    sh.fragmentShader = `varying float vFace;\nvarying vec3 vCol;\nvarying vec3 vBandC;\nvarying vec4 vSize;\nvarying vec3 vPos;\n${sh.fragmentShader}`.replace(
      "vec4 diffuseColor = vec4( diffuse, opacity );",
      `vec3 col;
  if (vFace < 0.5) {
    col = vCol * 0.92;
  } else {
    float px = (vPos.x + 0.5) * vSize.x;            // across the book's thickness (units)
    float fw = fwidth(px);
    float amp = clamp(1.6 - fw * 2.2, 0.0, 1.0);    // page lines fade out before they'd shimmer
    float lines = 0.5 + 0.5 * sin(px * 6.2831853 / 1.15);
    vec3 paper = vec3(0.86, 0.80, 0.66);            // linear cream
    col = paper * (1.0 - 0.13 * lines * amp);
    float edge = min(px, vSize.x - px);
    float board = vSize.w > 0.5 ? 1.8 : 0.6;
    float back = -vPos.z;                            // 0 at the spine .. 1 at the fore-edge
    if (vFace < 1.5) {
      col *= 0.7 - 0.22 * back;                      // the top: toned down, darker toward the back
      float fromSpine = back * vSize.z;
      if (vSize.w > 0.5 && fromSpine < 2.6 && edge >= board) col = mix(vBandC, vec3(0.86, 0.82, 0.72), step(0.5, fract(px * 0.45)));
    } else {
      col *= 0.9;
    }
    if (edge < board) col = vCol * 0.95;
  }
  vec4 diffuseColor = vec4(col, opacity);`,
    );
  };
  mat.customProgramCacheKey = () => "book-body";
  return mat;
}

/** Blob shadows with a per-instance strength. */
function blobMaterial(map: THREE.Texture) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: map, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = `attribute float iAlpha;\nvarying float vAlphaI;\n${sh.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vAlphaI = iAlpha;",
    );
    sh.fragmentShader = `varying float vAlphaI;\n${sh.fragmentShader}`.replace(
      "#include <alphamap_fragment>",
      "#include <alphamap_fragment>\n  diffuseColor.a *= vAlphaI;",
    );
  };
  mat.customProgramCacheKey = () => "blob";
  return mat;
}

// --- the scene -------------------------------------------------------------------

export class ShelfScene {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 40, 8000);
  private readonly engine: ShelfEngine3D;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly aniso: number;
  // texels per world unit, set from the on-screen density (view.k × DPR) in prepare()
  private spineRho = 2;
  private coverRho = 0.75; // side covers, seen at an angle on the drum
  private hiRho = 2.5; // a turned book's cover

  // atlases
  private spinePack = new AtlasPacker();
  private coverPack = new AtlasPacker();
  private platePack = new AtlasPacker(1024);
  private spineTex: THREE.CanvasTexture[] = [];
  private coverTex: THREE.CanvasTexture[] = [];
  private plateTex: THREE.CanvasTexture[] = [];
  private books = new Map<string, BookInfo>();
  private plates = new Map<number, Face>();
  /** cover images that arrived; repainted in idle time, never mid-spin */
  private paintQueue: BookInfo[] = [];
  private paintScheduled = false;
  // software canvases for face updates after the first upload: their pixels
  // go straight to the GPU (an accelerated canvas -> sRGB texture copy plus a
  // full-page generateMipmap cost ~15ms of GPU time per face)
  private scratch = document.createElement("canvas");
  private scratchCtx = this.scratch.getContext("2d", { willReadFrequently: true })!;
  private mipBuffers: Uint8Array[] = [];
  /** A reusable buffer per mip level (two levels are alive at once). */
  private mipBuffer(level: number, bytes: number) {
    const b = this.mipBuffers[level];
    if (b && b.length >= bytes) return b;
    return (this.mipBuffers[level] = new Uint8Array(Math.max(bytes, 4096)));
  }
  private maxH = 300;
  /** Everything visible at the first frame is baked. */
  ready = false;
  /** Faces baked synchronously because they came into view before the idle baker reached them. */
  lateBakes = 0;

  // meshes
  private body!: THREE.InstancedMesh;
  private spineMeshes: THREE.InstancedMesh[] = [];
  private coverMeshes: THREE.InstancedMesh[] = [];
  /** the back boards: the cover's print, a little duller (books lying face down, the drum's right end) */
  private backMeshes: THREE.InstancedMesh[] = [];
  // the insides of open books: cream paper, a faint title on the first page
  private innerTex: THREE.CanvasTexture | null = null;
  private innerFront: THREE.InstancedMesh | null = null;
  private innerBack: THREE.InstancedMesh | null = null;
  private innerSlots: InnerSlot[] = [];
  private innerSlotOf = new Map<string, InnerSlot>();
  private innerPlain = new Float32Array(4);
  private coverGeo: THREE.BufferGeometry | null = null;
  private backGeo: THREE.BufferGeometry | null = null;
  private plateMeshes: THREE.InstancedMesh[] = [];
  private ribbon!: THREE.InstancedMesh;
  private blob!: THREE.InstancedMesh;
  private slab!: THREE.InstancedMesh;
  private hi: Hi[] = [];
  private room = new THREE.Group();
  private roomTex: { lip: THREE.Texture; wallShadow: THREE.Texture } | null = null;
  /** the on-screen scale the marker lines were drawn for (they're redrawn when it changes much) */
  private lineK = 0;
  private roomMats: Record<"baseShadow" | "catcher" | "top" | "chamfer" | "lip" | "shadow", THREE.Material> | null = null;
  private roomKey = "";
  private roomMeshes: THREE.Mesh[] = [];
  /** the soft shadow under the desk's book (a plane just behind it, offset down-right) */
  private deskShadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private envTex: THREE.Texture | null = null;
  private host: THREE.Scene | null = null;
  tier: Tier = "high";
  private readIds: ReadonlySet<string> = new Set();
  private frameNo = 0;
  /** The books off the shelf in motion and the one on the desk (set by the canvas). */
  ground: GroundController | null = null;
  private camKey = "";
  private disposed = false;

  constructor(engine: ShelfEngine3D, renderer: THREE.WebGLRenderer) {
    this.engine = engine;
    this.renderer = renderer;
    // (no info-log queries at a program's first use in production: they block on the link, and
    // every program is compiled and link-awaited before the shelf shows; a dev build keeps them)
    renderer.debug.checkShaderErrors = !import.meta.env.PROD;
    this.aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    this.root.add(this.room);

    // one warm key light from the top-left (and a little in front), a soft fill
    this.key = new THREE.DirectionalLight(0xfff0da, 2.5);
    this.key.position.set(-950, 1250, 900);
    this.key.target.position.set(0, 110, -80);
    this.root.add(this.key, this.key.target);
    this.hemi = new THREE.HemisphereLight(0xfff4e6, 0x6b5039, 1.1);
    this.root.add(this.hemi);
    this.makeEnv();
  }

  private makeEnv() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex?.dispose();
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    if (this.host) this.host.environment = this.tier === "low" ? null : this.envTex;
  }

  attachTo(scene: THREE.Scene) {
    this.host = scene;
    scene.add(this.root);
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.3;
  }

  setRead(ids: ReadonlySet<string>) {
    this.readIds = ids;
  }

  // ------------------------------------------------------------ camera

  /**
   * Stage px -> camera. The eye sits E units above the plank, d in front of
   * the drum, looking level; the horizon lands at stage y = horizonY (often
   * above the stage). One world unit is k CSS px at the drum's front (z = 0).
   */
  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    this.camKey = "";
    this.updateCamera();
    this.buildRoom();
    this.fitShadow();
  }

  /**
   * The camera: one fixed eye-level view with exactly the shelf framing. With books
   * a desk open the canvas is taller and simply shows more below the plank.
   */
  updateCamera() {
    const v = this.engine.view;
    const key = `${v.w}|${v.h}|${v.frameH}`;
    if (key === this.camKey || v.w <= 0 || v.h <= 0) return;
    this.camKey = key;
    const { w, h, d, horizonY, E, k } = v;
    const fullH = 2 * Math.max(horizonY, h - horizonY);
    this.camera.fov = (2 * Math.atan(fullH / 2 / (k * d)) * 180) / Math.PI;
    this.camera.position.set(0, E, d);
    this.camera.rotation.set(0, 0, 0);
    // the shelf framing puts the horizon at horizonY; a taller canvas shows more below the plank
    this.camera.setViewOffset(w, fullH, 0, fullH / 2 - horizonY, w, h);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  // ------------------------------------------------------------ baking

  /**
   * An atlas page: the whole mip chain is allocated on the GPU, empty (no
   * 16 MB upload of a mostly blank page); faces arrive one rectangle (and its
   * mip levels) at a time.
   */
  private makeAtlasTex(canvas: HTMLCanvasElement) {
    const t = this.makeTex(canvas, false);
    t.mipmaps = new Array(Math.floor(Math.log2(canvas.width)) + 1).fill(canvas);
    t.generateMipmaps = false;
    t.source.dataReady = false;
    return t;
  }

  private makeTex(canvas: HTMLCanvasElement, flipY: boolean) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = flipY;
    t.anisotropy = this.aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }

  /** Allocate every face (cheap, deterministic) and build the meshes. */
  prepare(all: Essay[], issues: number[]) {
    if (!this.books.size) {
      // just above the on-screen density, so titles stay crisp (mipmaps handle the rest)
      const dens = (this.engine.view.k || 1.3) * this.renderer.getPixelRatio();
      const q = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.ceil(x * 4) / 4));
      // phones: cap the atlases (~3 spine + 2 cover pages)
      const phone = window.matchMedia("(pointer: coarse)").matches;
      let rho = q(dens + 0.25, 1.5, phone ? 2 : 3);
      // spines are tall: if a slightly lower density fits one more row of them
      // per atlas page, take it (e.g. 2.75 instead of 3 at DPR 2: 4 pages, not 7)
      const maxH = Math.max(...all.map((e) => e.height));
      const S = this.spinePack.size;
      const rows = Math.floor((S - 2) / (maxH * rho + 2));
      const snug = Math.floor(((S - 2) / (rows + 1) - 2) / maxH * 100) / 100;
      if (snug >= rho * 0.9) rho = snug;
      this.spineRho = rho;
      // side covers are only ever seen at an angle on the drum
      this.coverRho = Math.min(phone ? 0.75 : 0.9, Math.max(0.6, Math.round(dens * 0.45 * 4) / 4));
      this.hiRho = q(dens * 1.1, 2, 3.25);
    }
    for (const e of all) {
      if (this.books.has(e.id)) continue;
      const s = this.spinePack.alloc(e.width * this.spineRho, e.height * this.spineRho);
      const c = this.coverPack.alloc(COVER_W * this.coverRho, e.height * this.coverRho);
      const st = bookStyle(e);
      // (matte paper jackets; a hardcover's spine is a little rounder)
      const round = e.binding === "hardcover" ? 0.42 : e.binding === "mass" ? 0.2 : 0.28;
      this.books.set(e.id, {
        e,
        spine: { slot: s, uv: new Float32Array(uvOf(s, this.spinePack.size)), drawn: false },
        cover: { slot: c, uv: new Float32Array(uvOf(c, this.coverPack.size)), drawn: false },
        col: lin(st.base),
        band: lin(st.accent),
        rib: new THREE.Color(ribbonColour(st.base, st.accent)).convertSRGBToLinear(),
        mat: new Float32Array([MATTE, round, 0]),
        size: new Float32Array([e.width, e.height, BOOK_DEPTH, e.binding === "hardcover" ? 1 : 0]),
        img: e.cover ? undefined : null,
      });
      this.maxH = Math.max(this.maxH, e.height);
    }
    for (const n of issues) {
      if (this.plates.has(n)) continue;
      const s = this.platePack.alloc(LABEL_W * PLATE_RHO, LABEL_H * PLATE_RHO);
      this.plates.set(n, { slot: s, uv: new Float32Array(uvOf(s, this.platePack.size)), drawn: false });
    }
    const sync = (pack: AtlasPacker, list: THREE.CanvasTexture[]) =>
      pack.pages.forEach((p, i) => {
        if (list[i]) return;
        list[i] = this.makeAtlasTex(p.canvas);
        this.renderer.initTexture(list[i]); // allocate now, so faces can upload straight away
      });
    sync(this.spinePack, this.spineTex);
    sync(this.coverPack, this.coverTex);
    sync(this.platePack, this.plateTex);
    this.buildMeshes();
  }

  /** Baking cost (ms) by kind, for the debug report. */
  bakeStats: Record<string, { n: number; ms: number; max: number }> = {};

  private drawFace(pack: AtlasPacker, list: THREE.CanvasTexture[], f: Face, draw: (ctx: CanvasRenderingContext2D, x: number, y: number) => void) {
    const t0 = performance.now();
    this.drawFaceInner(pack, list, f, draw);
    const dt = performance.now() - t0;
    const kind = pack === this.spinePack ? "spine" : pack === this.coverPack ? "cover" : "plate";
    const st = (this.bakeStats[kind] ??= { n: 0, ms: 0, max: 0 });
    st.n++;
    st.ms += dt;
    st.max = Math.max(st.max, dt);
  }
  private drawFaceInner(pack: AtlasPacker, list: THREE.CanvasTexture[], f: Face, draw: (ctx: CanvasRenderingContext2D, x: number, y: number) => void) {
    const { slot } = f;
    const glTex = this.glTexOf(list[slot.page]);
    if (!glTex) return; // context lost: re-baked after the restore
    // draw into the (software) scratch canvas and upload just that rectangle, every mip level
    const sc = this.scratch;
    sc.width = slot.w;
    sc.height = slot.h;
    draw(this.scratchCtx, 0, 0);
    this.uploadRegion(glTex, pack.size, slot);
    f.drawn = true;
  }

  /**
   * Upload the scratch canvas into `slot` of an atlas texture, level 0 and a
   * CPU-downscaled copy for each mip level (only that rectangle; neighbours'
   * shared border texels at the smallest levels may mix, as mipmaps do).
   */
  private uploadRegion(glTex: WebGLTexture, size: number, slot: Slot) {
    const t0 = performance.now();
    this.uploadRegionInner(glTex, size, slot);
    const st = (this.bakeStats.upload ??= { n: 0, ms: 0, max: 0 });
    const dt = performance.now() - t0;
    st.n++;
    st.ms += dt;
    st.max = Math.max(st.max, dt);
  }
  private uploadRegionInner(glTex: WebGLTexture, size: number, slot: Slot) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const u8 = (d: ImageData) => new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
    this.renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    const lvl0 = this.scratchCtx.getImageData(0, 0, slot.w, slot.h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x, slot.y, slot.w, slot.h, gl.RGBA, gl.UNSIGNED_BYTE, u8(lvl0));
    // the mip chain of just this rectangle: 2×2 box filter in JS (slots are
    // 8-aligned, so levels 1-3 sit exactly on the page's grid; deeper levels
    // are within a texel)
    const levels = Math.floor(Math.log2(size));
    let src: Uint8Array | Uint8ClampedArray = lvl0.data;
    let sw = slot.w;
    let sh = slot.h;
    for (let L = 1; L <= levels; L++) {
      const dw = Math.max(1, (sw + 1) >> 1);
      const dh = Math.max(1, (sh + 1) >> 1);
      const dst = this.mipBuffer(L, dw * dh * 4);
      for (let j = 0; j < dh; j++) {
        const y0 = Math.min(sh - 1, j * 2);
        const y1 = Math.min(sh - 1, y0 + 1);
        for (let i = 0; i < dw; i++) {
          const x0 = Math.min(sw - 1, i * 2);
          const x1 = Math.min(sw - 1, x0 + 1);
          const a = (y0 * sw + x0) * 4;
          const b = (y0 * sw + x1) * 4;
          const c = (y1 * sw + x0) * 4;
          const d = (y1 * sw + x1) * 4;
          const o = (j * dw + i) * 4;
          dst[o] = (src[a] + src[b] + src[c] + src[d] + 2) >> 2;
          dst[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1] + 2) >> 2;
          dst[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2] + 2) >> 2;
          dst[o + 3] = (src[a + 3] + src[b + 3] + src[c + 3] + src[d + 3] + 2) >> 2;
        }
      }
      const lvlSize = Math.max(1, size >> L);
      const x = Math.min(slot.x >> L, lvlSize - 1);
      const y = Math.min(slot.y >> L, lvlSize - 1);
      const w = Math.min(dw, lvlSize - x);
      const h = Math.min(dh, lvlSize - y);
      if (w === dw) gl.texSubImage2D(gl.TEXTURE_2D, L, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, dst.subarray(0, dw * h * 4));
      src = dst;
      sw = dw;
      sh = dh;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }
  private glTexOf(tex: THREE.Texture): WebGLTexture | null {
    const p = this.renderer.properties.get(tex) as { __webglTexture?: WebGLTexture; __version?: number };
    // uploaded and current (a pending needsUpdate re-uploads the whole page anyway)
    return p.__webglTexture && p.__version === tex.version ? p.__webglTexture : null;
  }
  private paintSpine(b: BookInfo) {
    this.drawFace(this.spinePack, this.spineTex, b.spine, (ctx, x, y) => drawSpine(ctx, b.e, x, y, this.spineRho));
  }
  private paintCover(b: BookInfo) {
    b.cover.plain = false;
    this.drawFace(this.coverPack, this.coverTex, b.cover, (ctx, x, y) => drawCover(ctx, b.e, x, y, this.coverRho, b.img ?? null));
  }
  private paintCoverPlain(b: BookInfo) {
    b.cover.plain = true;
    this.drawFace(this.coverPack, this.coverTex, b.cover, (ctx, x, y) => drawCoverPlain(ctx, b.e, x, y, this.coverRho));
  }
  private paintPlate(n: number, f: Face) {
    this.drawFace(this.platePack, this.plateTex, f, (ctx, x, y) => drawPlate(ctx, n, x, y, PLATE_RHO));
  }

  /**
   * Bake what's ON SCREEN first: spines and bookend plates, plus quick
   * stand-ins for the covers (seen only at an angle at the edges), as fast as
   * possible; then resolve so the shelf can show. Everything else, full covers
   * included, bakes in idle time, nearest-first and leaning toward the drift.
   */
  async bake(): Promise<void> {
    const eng = this.engine;
    const row = eng.row;
    const vp = eng.viewPos;
    const order: { k: number; s: number; d: number }[] = [];
    for (let k = 0; k < row.K; k++) {
      const s = row.centerOf(row.nearestV(k, vp)) - vp;
      order.push({ k, s, d: s >= 0 ? s : -s * 1.4 });
    }
    order.sort((a, b) => a.d - b.d);
    const onScreen = eng.drum.sMax + ON_SCREEN_MARGIN;
    const first: (() => void)[] = [];
    const rest: (() => void)[] = [];
    const later = (b: BookInfo) => {
      rest.push(() => !b.spine.drawn && this.paintSpine(b));
      rest.push(() => (!b.cover.drawn || b.cover.plain) && this.paintCover(b));
    };
    for (const { k, s } of order) {
      const it = row.items[k];
      const visible = Math.abs(s) <= onScreen;
      if (it.kind === "book") {
        const b = this.books.get(it.essay.id);
        if (!b) continue;
        if (visible) {
          first.push(() => !b.spine.drawn && this.paintSpine(b));
          first.push(() => !b.cover.drawn && this.paintCoverPlain(b));
        }
        later(b);
      } else {
        const f = this.plates.get(it.issue);
        if (f) (visible ? first : rest).push(() => !f.drawn && this.paintPlate(it.issue, f));
      }
    }
    // then anything not on this shelf (other filters)
    for (const b of this.books.values()) later(b);
    for (const [n, f] of this.plates) rest.push(() => !f.drawn && this.paintPlate(n, f));

    let i = 0;
    await fastLoop(() => {
      if (this.disposed || i >= first.length) return false;
      first[i++]();
      return true;
    }, 10);
    if (this.disposed) return;
    this.ready = true;
    this.requestImages();
    // the rest, in small idle slices so frames stay short while the shelf moves
    let j = 0;
    void idleLoop(() => {
      if (this.disposed || j >= rest.length) return false;
      rest[j++]();
      return true;
    }, 8, 2);
  }

  /**
   * Repaint every face in idle time: the real fonts arrived after the first
   * bake used fallbacks, or the GPU context was restored (faces in view are
   * baked on the spot by update()).
   */
  rebakeAll() {
    if (this.disposed) return;
    const jobs: (() => void)[] = [];
    for (const b of this.books.values()) {
      jobs.push(() => this.paintSpine(b));
      jobs.push(() => this.paintCover(b));
    }
    for (const [n, f] of this.plates) jobs.push(() => this.paintPlate(n, f));
    let i = 0;
    void idleLoop(() => {
      if (this.disposed || i >= jobs.length) return false;
      jobs[i++]();
      this.engine.requestFrame();
      return true;
    }, 8, 2);
  }

  /**
   * Compile every program in parallel (KHR_parallel_shader_compile) while the
   * fonts load and the first faces bake, with every mesh and variant counted
   * in (hi-res covers, ribbons, plates).
   */
  compile(scene: THREE.Scene): Promise<void> {
    // (everything the first fall and the first open draw with is made and compiled here too,
    // before the shelf shows: the inner pages' atlas, the desk's shadow, the hi-res covers)
    this.ensureInnerAtlas();
    this.deskShadowMesh();
    const inst = [this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes, ...this.plateMeshes, this.ribbon, this.blob, this.slab, ...[this.innerFront, this.innerBack].filter((m): m is THREE.InstancedMesh => !!m)];
    const counts = inst.map((m) => m.count);
    for (const m of inst) m.count = Math.max(1, m.count);
    for (const h of this.hi) h.mesh.visible = true;
    // (the desk's shadow too, once it exists: a program linked at first use costs a frame, and
    // it first shows at the first open)
    const extra: THREE.Object3D[] = [];
    if (this.deskShadow) extra.push(this.deskShadow);
    const extraVis = extra.map((o) => o.visible);
    for (const o of extra) o.visible = true;
    // the programs compile in parallel (KHR_parallel_shader_compile); we wait for them
    // ourselves: three's compileAsync throws, and never settles, when a material in its set
    // is rebuilt meanwhile (its program gone), which left the shelf blank on a hash load
    let materials: Set<THREE.Material> | null = null;
    try {
      materials = this.renderer.compile(scene, this.camera) as Set<THREE.Material>;
    } catch {
      materials = null;
    }
    inst.forEach((m, i) => (m.count = counts[i]));
    for (const h of this.hi) h.mesh.visible = false;
    extra.forEach((o, i) => (o.visible = extraVis[i]));
    if (!materials || !materials.size) return Promise.resolve();
    const props = this.renderer.properties;
    const pending = materials;
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (this.disposed) return resolve();
        try {
          for (const m of [...pending]) {
            const p = (props.get(m) as { currentProgram?: { isReady?: () => boolean; usedTimes?: number } }).currentProgram;
            // (no program, or one released since: nothing left to wait for)
            if (!p || typeof p.isReady !== "function" || !((p.usedTimes ?? 0) > 0) || p.isReady()) pending.delete(m);
          }
        } catch {
          pending.clear();
        }
        if (!pending.size || performance.now() - t0 > 3000) resolve();
        else window.setTimeout(check, 10);
      };
      check();
    });
  }

  // ------------------------------------------------------- cover images

  private imgQueue: BookInfo[] = [];
  private imgActive = 0;

  /** Ask for the cover images of books in or near the view (a window, not all 270). */
  private requestImages() {
    const eng = this.engine;
    const row = eng.row;
    if (!row.K) return;
    const lim = eng.drum.sLim;
    const add = (v: number) => {
      const it = row.item(v);
      if (it.kind !== "book") return;
      const b = this.books.get(it.essay.id);
      if (!b || b.img !== undefined) return;
      b.img = null;
      this.imgQueue.push(b);
    };
    if (!row.looping) for (let v = 0; v < row.K; v++) add(v);
    else {
      // centre outward, leaning ahead of the drift
      const [a, z] = row.vRange(eng.pos - lim - 600, eng.pos + lim + 1600);
      const c = row.vAt(eng.pos);
      for (let d = 0; c + d <= z || c - d >= a; d++) {
        if (c + d <= z) add(c + d);
        if (d && c - d >= a) add(c - d);
      }
    }
    this.pump();
  }
  private isFast() {
    return this.engine.speed * this.engine.view.k > FAST;
  }

  /**
   * Repaint covers whose images arrived, in the browser's idle time (a cover
   * bake is ~1ms, up to ~7ms with a large image); one at a time when the
   * idle callback times out; none while the shelf spins.
   */
  private schedulePaints() {
    if (this.paintScheduled || !this.paintQueue.length || this.disposed) return;
    this.paintScheduled = true;
    const step = (d?: IdleDeadline) => {
      this.paintScheduled = false;
      if (this.disposed) return;
      if (!this.isFast()) {
        let painted = 0;
        while (this.paintQueue.length) {
          const room = d && !d.didTimeout ? d.timeRemaining() : painted ? 0 : 99;
          if (room < 4) break;
          this.paintCover(this.paintQueue.shift()!);
          painted++;
        }
        if (painted) this.engine.requestFrame();
      }
      this.schedulePaints();
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(step, { timeout: 400 });
    else window.setTimeout(() => step(), 50);
  }

  /** A turned book's cover image is wanted right away. */
  private wantImage(b: BookInfo) {
    if (b.img !== undefined) return;
    b.img = null;
    this.imgQueue.unshift(b);
    this.pump();
  }
  private pump() {
    while (this.imgActive < 3 && this.imgQueue.length) {
      const b = this.imgQueue.shift()!;
      this.imgActive++;
      const img = new Image();
      img.decoding = "async";
      (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
      img.src = b.e.cover!;
      img
        .decode()
        .then(() => {
          if (this.disposed) return;
          b.img = img;
          if (b.cover.drawn) {
            this.paintQueue.push(b);
            this.schedulePaints();
          }
          for (const h of this.hi) if (h.id === b.e.id) this.queueHiPaint(h);
          this.engine.requestFrame();
        })
        .catch(() => {})
        .finally(() => {
          this.imgActive--;
          this.pump();
        });
    }
  }

  // ------------------------------------------------------------- meshes

  private meshKey = "";

  private buildMeshes() {
    // (re)build only when the atlas page counts change
    const want = `${this.spineTex.length}/${this.coverTex.length}/${this.plateTex.length}`;
    if (this.meshKey === want) return;
    if (this.meshKey) this.disposeMeshes();
    this.meshKey = want;
    const sg = spineGeometry();
    const cg = coverGeometry();
    this.body = makeInstanced(bodyGeometry(), bodyMaterial(), { iColor: 3, iBand: 3, iSize: 4 });
    this.spineMeshes = this.spineTex.map((t, i) => makeInstanced(sg, atlasMaterial(t, `spine${i}`), { iUv: 4, iMat: 3 }));
    this.coverMeshes = this.coverTex.map((t, i) => makeInstanced(cg, atlasMaterial(t, `cover${i}`, { rough: MATTE }), { iUv: 4, iMat: 3 }));
    const bg = backGeometry();
    this.coverGeo = cg;
    this.backGeo = bg;
    this.backMeshes = this.coverTex.map((t, i) => makeInstanced(bg, atlasMaterial(t, `back${i}`, { rough: MATTE, tint: 0.84 }), { iUv: 4, iMat: 3 }));
    this.ribbon = new THREE.InstancedMesh(ribbonGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.5, side: THREE.DoubleSide }), CAPACITY);
    this.ribbon.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ribbon.frustumCulled = false;
    this.ribbon.setColorAt(0, new THREE.Color(1, 1, 1)); // allocates instanceColor
    this.ribbon.count = 0;
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    this.blob = makeInstanced(blobGeo, blobMaterial(new THREE.CanvasTexture(blobTexture())), { iAlpha: 1 });
    this.blob.renderOrder = 1;
    // the issue markers: short matte mustard books (their "#N" label is a plate on the spine)
    const mustard = new THREE.MeshStandardMaterial({ color: new THREE.Color(MARKER_COLOUR), roughness: MATTE, envMapIntensity: 0.55 });
    this.slab = makeInstanced(boxGeometry(), mustard, {}, 96);
    const plateGeo = new THREE.PlaneGeometry(1, 1);
    plateGeo.translate(0, 0.5, 0);
    this.plateMeshes = this.plateTex.map((t, i) =>
      makeInstanced(plateGeo, atlasMaterial(t, `plate${i}`, { rough: MATTE }), { iUv: 4, iMat: 3 }, 96),
    );
    // hi-res covers for turned books: one fixed-size canvas each (no reallocation)
    const W = Math.ceil(COVER_W * this.hiRho);
    const H = Math.ceil(this.maxH * this.hiRho);
    for (let i = 0; i < HI_SLOTS; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      canvas.getContext("2d", { willReadFrequently: true }); // software: a cheap upload per hover
      const tex = this.makeTex(canvas, true);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, envMapIntensity: 0.5 });
      const mesh = new THREE.Mesh(cg, mat);
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.castShadow = true;
      this.hi.push({ mesh, mat, tex, canvas, id: null, painted: null, paintedWithImg: false, queued: false });
      this.root.add(mesh);
    }
    for (const m of [this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes, this.slab]) m.castShadow = true;
    this.root.add(this.blob, this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes, this.ribbon, this.slab, ...this.plateMeshes);
    this.applyTier(this.tier, true);
  }
  private disposeMeshes() {
    for (const m of [this.innerFront, this.innerBack]) {
      if (!m) continue;
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.innerTex?.dispose();
    this.innerTex = null;
    this.innerFront = this.innerBack = null;
    this.innerSlots = [];
    this.innerSlotOf.clear();
    this.innerPlainSlot = null;
    for (const m of [this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes, ...this.plateMeshes, this.ribbon, this.blob, this.slab]) {
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const h of this.hi) {
      this.root.remove(h.mesh);
      h.mat.dispose();
      h.tex.dispose();
    }
    this.hi = [];
  }

  private queueHiPaint(h: Hi) {
    if (h.queued) return;
    h.queued = true;
    ric(() => {
      h.queued = false;
      if (this.disposed) return;
      const b = h.id ? this.books.get(h.id) : undefined;
      if (!b) return;
      const ctx = h.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, h.canvas.width, h.canvas.height);
      drawCover(ctx, b.e, 0, 0, this.hiRho, b.img ?? null);
      const used = Math.min(1, (b.e.height * this.hiRho) / h.canvas.height);
      h.tex.repeat.set(1, used);
      h.tex.offset.set(0, 1 - used);
      h.tex.needsUpdate = true;
      h.painted = b.e.id;
      h.paintedWithImg = !!b.img;
      this.engine.requestFrame();
    }, 80);
  }

  /**
   * A book's front cover made ready for the desk: its shelf-res cover baked and its image
   * asked for, and (when `now`) the hi-res desk cover painted at once. Called for the books
   * in view at idle, for the hovered book, and at the click (now).
   */
  prepareCover(id: string, now = false) {
    const b = this.books.get(id);
    if (!b || this.disposed || !this.ready) return;
    if (!b.cover.drawn) this.paintCover(b);
    this.wantImage(b);
    if (!now) return;
    const h = this.hi.find((x) => x.id === id) ?? this.hi.find((x) => x.id === null && x.painted === id) ?? this.hi.find((x) => x.id === null);
    if (h && (h.painted !== id || (b.img && !h.paintedWithImg))) {
      h.id = id;
      this.paintHiNow(h, b);
    }
    this.engine.requestFrame();
  }
  /** Whether a book's cover is ready to show large (its hi-res print painted). */
  coverReady(id: string) {
    return this.hi.some((h) => h.painted === id);
  }
  private paintHiNow(h: Hi, b: BookInfo) {
    const ctx = h.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, h.canvas.width, h.canvas.height);
    drawCover(ctx, b.e, 0, 0, this.hiRho, b.img ?? null);
    const used = Math.min(1, (b.e.height * this.hiRho) / h.canvas.height);
    h.tex.repeat.set(1, used);
    h.tex.offset.set(0, 1 - used);
    h.tex.needsUpdate = true;
    h.painted = b.e.id;
    h.paintedWithImg = !!b.img;
  }

  /** Debug: bake every spine now and report how many had their title cut (?debug checks). */
  debugBakeAllSpines() {
    for (const b of this.books.values()) if (!b.spine.drawn) this.paintSpine(b);
    return { ...spineStats };
  }

  /** Debug: one of a book's baked pages at full density, as a data URL. */
  debugPage(id: string, kind: "text" | "title" | "back"): string | null {
    const b = this.books.get(id);
    if (!b) return null;
    const c = document.createElement("canvas");
    const rho = 3;
    c.width = Math.ceil(COVER_W * rho);
    c.height = Math.ceil(b.e.height * rho);
    const ctx = c.getContext("2d")!;
    if (kind === "text") drawTextPage(ctx, b.e, 0, 0, rho, b.e.height, 1 + (b.e.issues[0] ?? 0) * 2);
    else if (kind === "title") drawTitlePage(ctx, b.e, 0, 0, rho, b.e.height);
    else drawBackCover(ctx, b.e, 0, 0, rho, b.e.height);
    return c.toDataURL("image/png");
  }
  /** The inner-page atlas: one 1024² page of equal slots, the first painted plain paper. */
  private ensureInnerAtlas() {
    if (this.innerTex || !this.coverGeo || !this.backGeo) return;
    const R = 1;
    const S = 2048;
    const al = (n: number) => Math.ceil(n / 8) * 8;
    const sw = Math.ceil(COVER_W * R);
    const sh = Math.ceil(this.maxH * R);
    const cols = Math.floor(S / al(sw + 2));
    const rows = Math.floor(S / al(sh + 2));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const tex = this.makeAtlasTex(canvas);
    this.renderer.initTexture(tex);
    this.innerTex = tex;
    const mat = (geo: THREE.BufferGeometry, key: string) => makeInstanced(geo, atlasMaterial(tex, key, { rough: 0.92 }), { iUv: 4, iMat: 3 }, 240);
    this.innerFront = mat(this.coverGeo, "innerF");
    this.innerBack = mat(this.backGeo, "innerB");
    this.innerFront.receiveShadow = this.innerBack.receiveShadow = this.tier === "high";
    this.root.add(this.innerFront, this.innerBack);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) this.innerSlots.push({ rect: { page: 0, x: c * al(sw + 2), y: r * al(sh + 2), w: sw, h: sh }, uv: new Float32Array(4), id: null, painted: null, withImg: false, used: -1, queued: false });
    // slot 0: plain paper (the inside of a cover, the page group's face, the fanned leaves)
    this.innerPlainSlot = this.innerSlots.shift()!;
    this.innerPlain.set(uvOf(this.innerPlainSlot.rect, S));
    this.paintInnerPlain();
  }
  private innerPlainSlot: InnerSlot | null = null;
  /** Paints the plain-paper slot once the texture is on the GPU (tried again each frame until it is). */
  private paintInnerPlain() {
    const slot = this.innerPlainSlot;
    if (!slot || slot.painted || !this.innerTex) return;
    const glTex = this.glTexOf(this.innerTex);
    if (!glTex) return;
    this.scratch.width = slot.rect.w;
    this.scratch.height = slot.rect.h;
    drawInnerPage(this.scratchCtx, null, 0, 0, 1, this.maxH);
    this.uploadRegion(glTex, 2048, slot.rect);
    slot.painted = "plain";
  }
  /**
   * The book's page slot of a kind (a page of body text, or the title page inside the front
   * cover) if it's painted; requests and paints one in idle time otherwise.
   */
  private innerSlotFor(b: BookInfo, kind: "text" | "title"): InnerSlot | null {
    this.ensureInnerAtlas();
    const id = `${b.e.id}|${kind}`;
    let fs = this.innerSlotOf.get(id);
    if (!fs) {
      let best: InnerSlot | null = null;
      for (const c of this.innerSlots) {
        if (c.used === this.frameNo) continue;
        if (!best || c.used < best.used) best = c;
      }
      if (!best) return null;
      if (best.id) this.innerSlotOf.delete(best.id);
      best.id = id;
      best.painted = null;
      this.innerSlotOf.set(id, best);
      fs = best;
    }
    fs.used = this.frameNo;
    if (!fs.queued && fs.painted !== id) {
      fs.queued = true;
      this.innerQueue.push({ fs, b, kind, id });
      this.scheduleInnerPaints();
    }
    return fs.painted === id ? fs : null;
  }
  private innerQueue: { fs: InnerSlot; b: BookInfo; kind: "text" | "title"; id: string }[] = [];
  private innerPaintScheduled = false;
  /**
   * The page paints (a typeset page is ~2 ms) go in idle slices with a time budget, so the
   * dozens a fall asks for at once never land in one frame; the plain page shows until then.
   */
  private scheduleInnerPaints() {
    if (this.innerPaintScheduled) return;
    this.innerPaintScheduled = true;
    const step = (d?: IdleDeadline) => {
      this.innerPaintScheduled = false;
      if (this.disposed) return;
      let n = 0;
      const busy = performance.now() - this.lastFrameAt < 150;
      const t0 = performance.now();
      while (this.innerQueue.length) {
        const room = d && !d.didTimeout ? d.timeRemaining() : n || busy ? 0 : 99;
        if (room < 6 || performance.now() - t0 > 8) break;
        const job = this.innerQueue.shift()!;
        job.fs.queued = false;
        if (job.fs.id === job.id && this.innerTex) {
          const glTex = this.glTexOf(this.innerTex);
          if (glTex) {
            const rect = { ...job.fs.rect, h: Math.ceil(job.b.e.height) };
            this.scratch.width = rect.w;
            this.scratch.height = rect.h;
            if (job.kind === "text") drawTextPage(this.scratchCtx, job.b.e, 0, 0, 1, job.b.e.height, 1 + (job.b.e.issues[0] ?? 0) * 2);
            else drawTitlePage(this.scratchCtx, job.b.e, 0, 0, 1, job.b.e.height);
            this.uploadRegion(glTex, 2048, rect);
            job.fs.uv.set(uvOf(rect, 2048));
            job.fs.painted = job.id;
            n++;
          }
        }
      }
      if (n) this.engine.requestFrame();
      if (this.innerQueue.length) {
        this.innerPaintScheduled = true;
        ric(step, 120);
      }
    };
    ric(step, 120);
  }

  /** Give each turning book a hi-res slot (kept by id across frames). */
  private assignHi(turning: string[]) {
    for (const h of this.hi) if (h.id && !turning.includes(h.id)) h.id = null;
    for (const id of turning) {
      if (this.hi.some((h) => h.id === id)) continue;
      const free = this.hi.find((h) => h.id === null && h.painted === id) ?? this.hi.find((h) => h.id === null);
      if (!free) break;
      free.id = id;
      const b = this.books.get(id);
      if (b) this.wantImage(b);
      if (free.painted !== id) this.queueHiPaint(free);
    }
    for (const h of this.hi) {
      const b = h.id ? this.books.get(h.id) : undefined;
      if (b?.img && h.painted === h.id && !h.paintedWithImg) this.queueHiPaint(h);
    }
  }

  // -------------------------------------------------------------- room

  private buildRoom() {
    const drum = this.engine.drum;
    const lim = drum.sLim + 400;
    const k = this.engine.view.k || 1;
    // the strips follow the drum's width only: a taller canvas (a desk opening) changes
    // nothing here, and the materials are made once (a material rebuilt while
    // the startup compile still waits on it would lose its program under that wait)
    const roomKey = `${lim}|${drum.sMax}`;
    // the marker lines are drawn ~1.5 CSS px thick: redrawn when the on-screen scale moves by 15 %
    const redraw = !this.lineK || Math.abs(k / this.lineK - 1) > 0.15;
    if (roomKey === this.roomKey && this.roomMeshes.length && !redraw) return;
    this.roomKey = roomKey;
    for (const m of this.roomMeshes) {
      this.room.remove(m);
      m.geometry.dispose();
    }
    this.roomMeshes = [];
    const tex = (c: HTMLCanvasElement, rep: boolean) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = rep ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = this.aniso;
      return t;
    };
    if (!this.roomTex || redraw) {
      this.lineK = k;
      const old = this.roomTex;
      this.roomTex = {
        lip: tex(lipTexture(LIP, k), true),
        wallShadow: old?.wallShadow ?? new THREE.CanvasTexture(wallShadowTexture()),
      };
      if (this.roomMats) {
        // (same kind of map: the programs stay)
        (this.roomMats.lip as THREE.MeshBasicMaterial).map = this.roomTex.lip;
      }
      old?.lip.dispose();
    }
    const { lip: lipTex, wallShadow } = this.roomTex;
    const N = Math.ceil((2 * lim) / 12);
    const at = { x: 0, z: 0, phi: 0 };
    // a strip along the drum between (offA, yA) and (offB, yB); v = 1 at A
    const strip = (offA: number, yA: number, offB: number, yB: number, uScale: number) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= N; i++) {
        const s = -lim + (2 * lim * i) / N;
        drum.at(s, at);
        const nx = Math.sin(at.phi);
        const nz = Math.cos(at.phi);
        pos.push(at.x + nx * offA, yA, at.z + nz * offA, at.x + nx * offB, yB, at.z + nz * offB);
        uv.push(s / uScale, 1, s / uScale, 0);
        if (i < N) {
          const o = i * 2;
          idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    if (!this.roomMats) {
      const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...p });
      // (every shadow is pure black: a tinted one would lift the black page into a halo)
      this.roomMats = {
        baseShadow: new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: wallShadow, transparent: true, opacity: 0.2, depthWrite: false }),
        catcher: new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.2, depthWrite: false }),
        // matte charcoal; the front edge catches a little more of the light
        top: std({ color: new THREE.Color(SHELF_COLOUR), roughness: 0.9, envMapIntensity: 0.25 }),
        chamfer: std({ color: new THREE.Color("#2a2a2a"), roughness: 0.8, envMapIntensity: 0.3 }),
        // the front lip: drawn flat, so the marker line stays its own off-white
        lip: new THREE.MeshBasicMaterial({ map: lipTex, side: THREE.DoubleSide, toneMapped: false }),
        shadow: new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: wallShadow, transparent: true, opacity: 0.32, depthWrite: false }),
      };
    }
    const M = this.roomMats;
    // No wall: the page itself is the background. Behind the books, an invisible
    // plane only catches shadows: a soft baked one along the base (every tier)
    // and the real cast shadows from the key light (HIGH, a shadow map).
    const baseShadow = new THREE.Mesh(strip(-PANEL_BACK, 0, -PANEL_BACK, 90, 512), M.baseShadow);
    const catcher = new THREE.Mesh(strip(-PANEL_BACK, PANEL_H, -PANEL_BACK, 0, 512), M.catcher);
    catcher.receiveShadow = true;
    const top = new THREE.Mesh(strip(-PANEL_BACK, 0, PLANK_FRONT - 2, 0, 1024), M.top);
    const chamfer = new THREE.Mesh(strip(PLANK_FRONT - 2, 0, PLANK_FRONT, -2, 1024), M.chamfer);
    // (the lip's texture spans its full height: the marker line traces its top and bottom edges)
    const lip = new THREE.Mesh(strip(PLANK_FRONT, 0, PLANK_FRONT, -LIP, 1024), M.lip);
    const shadow = new THREE.Mesh(strip(PLANK_FRONT - 30, -LIP, PLANK_FRONT - 30, -LIP - 56, 512), M.shadow);
    shadow.position.x = 6; // falling away from the top-left light
    top.receiveShadow = true;
    this.roomMeshes = [catcher, baseShadow, top, chamfer, lip, shadow];
    this.room.add(...this.roomMeshes);
  }

  /** Fit the key light's shadow camera tightly around the shelf (light-space bounds). */
  private fitShadow() {
    const s = this.key.shadow;
    const cam = s.camera as THREE.OrthographicCamera;
    const half = this.engine.view.halfW / this.engine.view.k + 260;
    const view = new THREE.Matrix4().lookAt(this.key.position, this.key.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(this.key.position);
    const inv = view.clone().invert();
    const p = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    // (the shelf, and a little below the plank's lip, where the books tip over its edge)
    for (const x of [-half, half])
      for (const y of [-LIP - 160, PANEL_H])
        for (const z of [-PANEL_BACK - 420, PLANK_FRONT + 340]) {
          p.set(x, y, z).applyMatrix4(inv);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
    cam.left = minX;
    cam.right = maxX;
    cam.bottom = minY;
    cam.top = maxY;
    cam.near = Math.max(1, -maxZ - 10);
    cam.far = -minZ + 10;
    cam.updateProjectionMatrix();
    // a 4096 map where the GPU allows it: the shelf's width gets the texels (soft PCF on top);
    // the map itself is kept across refits (a resize): re-allocating 32 MB and rendering into
    // it afresh stalled the first frame after a desk opened by ~100 ms
    const big = this.renderer.capabilities.maxTextureSize >= 4096 && !this.mobile;
    const mw = big ? 4096 : 2048;
    const mh = big ? 2048 : 1024;
    if (s.mapSize.x !== mw || s.mapSize.y !== mh) {
      s.mapSize.set(mw, mh);
      if (s.map) {
        s.map.dispose();
        s.map = null;
      }
    }
    s.bias = -0.0004;
    s.normalBias = 1.6;
    s.radius = 4;
    s.needsUpdate = true;
  }
  private mobile = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  // -------------------------------------------------------------- tiers

  applyTier(tier: Tier, force = false) {
    const changed = force || this.tier !== tier;
    this.tier = tier;
    const high = tier === "high";
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.key.castShadow = high;
    for (const m of [this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes]) if (m) m.receiveShadow = high;
    if (this.host) this.host.environment = tier === "low" ? null : this.envTex;
    if (changed) {
      this.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
  }

  // -------------------------------------------------------------- frame

  private P = { x: 0, y: 0, z: 0, rotY: 0, lean: 0, turn: 0 };
  private T = { x: 0, z: 0, phi: 0 };

  /**
   * Write every visible item's instance data. Returns how many visible faces
   * had nothing baked at draw time (always 0 by construction: a face that
   * comes into view before the idle baker reaches it is baked right here and
   * counted in lateBakes).
   */
  /** when the last frame was drawn (the inner pages' paints keep out of busy stretches) */
  private lastFrameAt = 0;

  /**
   * A face that comes into view before the idle baker reached it is baked right here, within
   * a few ms per frame; past that the book draws without its print this frame and the face
   * is baked in the next idle slice (a topic change can bring tens into view at once).
   */
  private bakeBudgetUntil = 0;
  deferredBakes = 0;
  private bakeSoon = new Set<BookInfo>();
  private bakeSoonScheduled = false;
  private lateBake(b: BookInfo, what: "spine" | "cover"): boolean {
    if (performance.now() < this.bakeBudgetUntil) {
      if (what === "spine") this.paintSpine(b);
      else this.paintCover(b);
      this.lateBakes++;
      return true;
    }
    this.deferredBakes++;
    this.bakeSoon.add(b);
    if (!this.bakeSoonScheduled) {
      this.bakeSoonScheduled = true;
      const step = (d?: IdleDeadline) => {
        this.bakeSoonScheduled = false;
        if (this.disposed) return;
        const t0 = performance.now();
        let n = 0;
        for (const bb of [...this.bakeSoon]) {
          if ((d && !d.didTimeout ? d.timeRemaining() : 99) < 4 || performance.now() - t0 > 8) break;
          if (!bb.spine.drawn) this.paintSpine(bb);
          if (!bb.cover.drawn) this.paintCoverPlain(bb);
          this.bakeSoon.delete(bb);
          n++;
        }
        if (n) this.engine.requestFrame();
        if (this.bakeSoon.size) {
          this.bakeSoonScheduled = true;
          ric(step, 40);
        }
      };
      ric(step, 40);
    }
    return false;
  }

  update(): number {
    if (!this.ready) return 0;
    this.frameNo++;
    this.lastFrameAt = performance.now();
    this.bakeBudgetUntil = this.lastFrameAt + LATE_BAKE_MS;
    this.updateCamera();
    if (this.ground?.items.size) {
      this.ensureInnerAtlas();
      this.paintInnerPlain();
    }
    if (this.frameNo % 30 === 0 && !this.isFast()) this.requestImages();
    const eng = this.engine;
    const row = eng.row;
    const P = this.P;
    let nBody = 0;
    let nRib = 0;
    let nBlob = 0;
    let nSlab = 0;
    let blank = 0;
    const nSpine = this.spineMeshes.map(() => 0);
    const nCover = this.coverMeshes.map(() => 0);
    const nBack = this.backMeshes.map(() => 0);
    let nInnerF = 0;
    let nInnerB = 0;
    const nPlate = this.plateMeshes.map(() => 0);

    // books turning (hover / selection) get hi-res covers
    const turning: string[] = [];
    for (const v of eng.turningNow()) {
      const it = row.item(v);
      if (it.kind === "book" && !turning.includes(it.essay.id)) turning.push(it.essay.id);
    }
    // the desk's book shows its cover large: the crisp hi-res print, like a turned book's
    const deskBook = this.ground?.deskBook();
    if (deskBook && !turning.includes(deskBook.id)) turning.push(deskBook.id);
    this.assignHi(turning);
    const hiShown = new Set<Hi>();

    const bodyM = this.body.instanceMatrix.array as Float32Array;
    const bodyCol = this.body.geometry.getAttribute("iColor").array as Float32Array;
    const bodyBand = this.body.geometry.getAttribute("iBand").array as Float32Array;
    const bodySize = this.body.geometry.getAttribute("iSize").array as Float32Array;
    const ribM = this.ribbon.instanceMatrix.array as Float32Array;
    const ribC = this.ribbon.instanceColor!.array as Float32Array;
    const slabM = this.slab.instanceMatrix.array as Float32Array;

    // rotation columns of Ry(rotY)·Rz(lean)
    let r0x = 0;
    let r0y = 0;
    let r0z = 0;
    let r1x = 0;
    let r1y = 0;
    let r1z = 0;
    let r2x = 0;
    let r2y = 0;
    let r2z = 0;
    const put = (a: ArrayLike<number> & { [i: number]: number }, i: number, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number) => {
      const o = i * 16;
      a[o] = r0x * sx;
      a[o + 1] = r0y * sx;
      a[o + 2] = r0z * sx;
      a[o + 3] = 0;
      a[o + 4] = r1x * sy;
      a[o + 5] = r1y * sy;
      a[o + 6] = r1z * sy;
      a[o + 7] = 0;
      a[o + 8] = r2x * sz;
      a[o + 9] = r2y * sz;
      a[o + 10] = r2z * sz;
      a[o + 11] = 0;
      a[o + 12] = tx;
      a[o + 13] = ty;
      a[o + 14] = tz;
      a[o + 15] = 1;
    };
    const putAtlas = (m: THREE.InstancedMesh, i: number, uv: Float32Array, r: number, round: number, shade = 0) => {
      const u = m.geometry.getAttribute("iUv").array as Float32Array;
      u[i * 4] = uv[0];
      u[i * 4 + 1] = uv[1];
      u[i * 4 + 2] = uv[2];
      u[i * 4 + 3] = uv[3];
      const t = m.geometry.getAttribute("iMat").array as Float32Array;
      t[i * 3] = r;
      t[i * 3 + 1] = round;
      t[i * 3 + 2] = shade;
    };

    /** One book's instances (body, spine, cover or its hi-res cover, ribbon) at origin (ox, oy, oz) with r0..r2. */
    const book = (b: BookInfo, ox: number, oy: number, oz: number, turn: number, force = false) => {
      const e = b.e;
      const w = e.width;
      const h = e.height;
      const D = BOOK_DEPTH;
      put(bodyM, nBody, w, h, D, ox, oy, oz);
      bodyCol.set(b.col, nBody * 3);
      bodyBand.set(b.band, nBody * 3);
      bodySize.set(b.size, nBody * 4);
      nBody++;

      // spine face
      let deferred = false;
      if (!b.spine.drawn && !this.lateBake(b, "spine")) deferred = true;
      if (b.spine.drawn) {
        const m = this.spineMeshes[b.spine.slot.page];
        const i = nSpine[b.spine.slot.page]++;
        put(m.instanceMatrix.array as Float32Array, i, w, h, D, ox, oy, oz);
        putAtlas(m, i, b.spine.uv, b.mat[0], b.mat[1]);
      }

      // the boards of a book standing on the shelf are its sides, glimpsed past shorter neighbours
      // and at the drum's ends: in shade, so the row reads by its spines (a book off the shelf, or
      // turned, shows them fully lit)
      const side = force || turn > 0.001 ? 0 : SIDE_SHADE;
      // front board: the hi-res cover once painted, else the atlas cover
      let hiSlot: Hi | null = null;
      if (turn > 0.001) for (const hs of this.hi) if (hs.id === e.id && hs.painted === e.id) hiSlot = hs;
      if (hiSlot && !hiShown.has(hiSlot)) {
        hiShown.add(hiSlot);
        put(hiSlot.mesh.matrix.elements, 0, w, h, D, ox + r0x * 0.12, oy + r0y * 0.12, oz + r0z * 0.12);
        hiSlot.mesh.matrixWorldNeedsUpdate = true;
        hiSlot.mesh.visible = true;
      } else {
        // (a book off the shelf shows a face, never a blank board: its cover is baked now if it must be)
        if (!b.cover.drawn && force) this.paintCover(b);
        if (!b.cover.drawn && !this.lateBake(b, "cover")) deferred = true;
        if (b.cover.drawn) {
          const m = this.coverMeshes[b.cover.slot.page];
          const i = nCover[b.cover.slot.page]++;
          put(m.instanceMatrix.array as Float32Array, i, w, h, D, ox, oy, oz);
          putAtlas(m, i, b.cover.uv, MATTE, 0, side);
        }
      }
      if (b.cover.drawn) {
        const m = this.backMeshes[b.cover.slot.page];
        const i = nBack[b.cover.slot.page]++;
        put(m.instanceMatrix.array as Float32Array, i, w, h, D, ox, oy, oz);
        putAtlas(m, i, b.cover.uv, MATTE, 0, side);
      }
      if ((!b.spine.drawn || !b.cover.drawn) && !deferred) blank++;

      // read ribbon, hanging over the spine from the head
      if (this.readIds.has(e.id) && nRib < CAPACITY) {
        const ry = h - 32;
        const rx = w * 0.18;
        put(ribM, nRib, Math.min(7, w * 0.3), 34, 1, ox + r0x * rx + r1x * ry + r2x * 0.4, oy + r0y * rx + r1y * ry + r2y * 0.4, oz + r0z * rx + r1z * ry + r2z * 0.4);
        ribC[nRib * 3] = b.rib.r;
        ribC[nRib * 3 + 1] = b.rib.g;
        ribC[nRib * 3 + 2] = b.rib.b;
        nRib++;
      }
    };

    const finishAll = (blank: number) => {
      for (const h of this.hi) if (!hiShown.has(h)) h.mesh.visible = false;

      const finish = (m: THREE.InstancedMesh, n: number, attrs: string[]) => {
        m.count = n;
        if (!n) return;
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
        for (const a of attrs) {
          const at = m.geometry.getAttribute(a) as THREE.InstancedBufferAttribute;
          at.clearUpdateRanges();
          at.addUpdateRange(0, n * at.itemSize);
          at.needsUpdate = true;
        }
      };
      finish(this.body, nBody, ["iColor", "iBand", "iSize"]);
      this.spineMeshes.forEach((m, i) => finish(m, nSpine[i], ["iUv", "iMat"]));
      this.coverMeshes.forEach((m, i) => finish(m, nCover[i], ["iUv", "iMat"]));
      this.backMeshes.forEach((m, i) => finish(m, nBack[i], ["iUv", "iMat"]));
      if (this.innerFront) finish(this.innerFront, nInnerF, ["iUv", "iMat"]);
      if (this.innerBack) finish(this.innerBack, nInnerB, ["iUv", "iMat"]);
      this.plateMeshes.forEach((m, i) => finish(m, nPlate[i], ["iUv", "iMat"]));
      finish(this.slab, nSlab, []);
      finish(this.blob, nBlob, ["iAlpha"]);
      this.ribbon.count = nRib;
      if (nRib) {
        this.ribbon.instanceMatrix.clearUpdateRanges();
        this.ribbon.instanceMatrix.addUpdateRange(0, nRib * 16);
        this.ribbon.instanceMatrix.needsUpdate = true;
        const ic = this.ribbon.instanceColor!;
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, nRib * 3);
        ic.needsUpdate = true;
      }
    return blank;
    };
    const onScreen = eng.drum.sMax + ON_SCREEN_MARGIN;
    eng.forEachVisible((v, s) => {
      const it = row.item(v);
      const seen = Math.abs(s) <= onScreen;
      eng.poseOf(v, s, P, this.T);
      const c = Math.cos(P.rotY);
      const sn = Math.sin(P.rotY);
      const cl = Math.cos(P.lean);
      const sl = Math.sin(P.lean);
      r0x = c * cl;
      r0y = sl;
      r0z = -sn * cl;
      r1x = -c * sl;
      r1y = cl;
      r1z = sn * sl;
      r2x = sn;
      r2y = 0;
      r2z = c;

      if (it.kind === "marker") {
        if (nSlab >= 96) return;
        const f = this.plates.get(it.issue);
        if (f && !f.drawn && !seen) return; // off screen and not baked yet: nothing to see
        const grow = eng.markerScale(it.issue);
        r1x *= grow;
        r1y *= grow;
        r1z *= grow;
        put(slabM, nSlab++, MARKER_W, MARKER_H, SLAB_D, P.x, P.y, P.z);
        if (f) {
          if (!f.drawn) {
            this.paintPlate(it.issue, f);
            this.lateBakes++;
          }
          const m = this.plateMeshes[f.slot.page];
          const i = nPlate[f.slot.page]++;
          const oy = MARKER_H - LABEL_H;
          put(m.instanceMatrix.array as Float32Array, i, LABEL_W, LABEL_H, 1, P.x + r1x * oy + r2x * 0.4, P.y + r1y * oy, P.z + r1z * oy + r2z * 0.4);
          putAtlas(m, i, f.uv, MATTE, 0);
        }
        this.putBlob(nBlob++, P.x, P.z, r2x, r2z, MARKER_W, SLAB_D, 0.42, 0);
        return;
      }

      const e = it.essay;
      const b = this.books.get(e.id);
      if (!b || nBody >= CAPACITY || eng.hidden.has(e.id)) return;
      if (!seen && (!b.spine.drawn || !b.cover.drawn)) return; // off screen and not baked yet
      book(b, P.x, P.y, P.z, P.turn);
      // contact shadow; a turned book's grows, softens and slides away from the light
      this.putBlob(nBlob++, P.x, P.z, r2x, r2z, e.width, BOOK_DEPTH, 0.5 - 0.22 * P.turn, P.turn);
    });

    // bookends leaving the shelf shrink away where they stood
    for (const m of eng.leavingMarkers) {
      if (nSlab >= 96) break;
      const f = this.plates.get(m.issue);
      eng.drum.at(m.s, this.T);
      const g = Math.max(0.001, 1 - Math.min(1, (eng.lastFrameTime - m.at) / 250));
      const c = Math.cos(this.T.phi);
      const sn = Math.sin(this.T.phi);
      r0x = c;
      r0y = 0;
      r0z = -sn;
      r1x = 0;
      r1y = g;
      r1z = 0;
      r2x = sn;
      r2y = 0;
      r2z = c;
      put(slabM, nSlab++, MARKER_W, MARKER_H, SLAB_D, this.T.x, 0, this.T.z);
      if (f?.drawn) {
        const pm = this.plateMeshes[f.slot.page];
        const i = nPlate[f.slot.page]++;
        const oy = (MARKER_H - LABEL_H) * g;
        put(pm.instanceMatrix.array as Float32Array, i, LABEL_W, LABEL_H * g, 1, this.T.x + r2x * 0.4, oy, this.T.z + r2z * 0.4);
        putAtlas(pm, i, f.uv, MATTE, 0);
      }
    }

    // books off the shelf (falling, flying back, on the desk): every part (a closed book, or
    // base + pages + cover + fan leaves), at the shelf's resolution (the desk's book crisper)
    if (this.ground) {
      const setRot = (q: THREE.Quaternion) => {
        _rot.makeRotationFromQuaternion(q);
        const m = _rot.elements;
        r0x = m[0];
        r0y = m[1];
        r0z = m[2];
        r1x = m[4];
        r1y = m[5];
        r1z = m[6];
        r2x = m[8];
        r2y = m[9];
        r2z = m[10];
      };
      /** a part's geometry origin (spine bottom centre) from its centre */
      const origin = (rp: RenderPart) => {
        _o.set(rp.pos.x - r1x * rp.half.y + r2x * rp.half.z, rp.pos.y - r1y * rp.half.y + r2y * rp.half.z, rp.pos.z - r1z * rp.half.y + r2z * rp.half.z);
      };
      const inner = (mesh: THREE.InstancedMesh | null, i: number, uv: Float32Array, w: number, h: number, D: number) => {
        if (!mesh) return i;
        put(mesh.instanceMatrix.array as Float32Array, i, w, h, D, _o.x, _o.y, _o.z);
        putAtlas(mesh, i, uv, 0.92, 0);
        return i + 1;
      };
      for (const it of this.ground.items.values()) {
        if (nBody >= CAPACITY - 8) break;
        const b = this.books.get(it.id);
        if (!b || !it.render.length) continue;
        if (this.debugHideDesk && (it.state === "desk" || it.state === "flight")) continue;
        _ndc.copy(it.wc).project(this.camera);
        if (Math.abs(_ndc.x) > 1.15 || Math.abs(_ndc.y) > 1.5 || _ndc.z > 1) continue;
        const e = it.e;
        const D = BOOK_DEPTH;
        const h = e.height;
        for (const rp of it.render) {
          setRot(rp.quat);
          origin(rp);
          const w = rp.half.x * 2;
          if (rp.kind === "whole") {
            // (the desk's book: the crisp print once painted, the shelf's until then; a book off
            // the shelf shows a face, never a blank board: its cover is baked now if it must be)
            const onDesk = deskBook?.id === it.id && this.hi.some((hs) => hs.id === it.id && hs.painted === it.id);
            book(b, _o.x, _o.y, _o.z, onDesk ? 1 : 0, true);
            continue;
          }
          if (rp.kind === "base") {
            // the back board with the bulk of the pages: the back's print, plain paper on its +x face, the spine
            if (!b.spine.drawn) this.lateBake(b, "spine");
            if (!b.cover.drawn) this.lateBake(b, "cover");
            put(bodyM, nBody, w, h, D, _o.x, _o.y, _o.z);
            bodyCol.set(b.col, nBody * 3);
            bodyBand.set(b.band, nBody * 3);
            bodySize.set(b.size, nBody * 4);
            bodySize[nBody * 4] = w;
            nBody++;
            if (b.cover.drawn) {
              const m = this.backMeshes[b.cover.slot.page];
              const i = nBack[b.cover.slot.page]++;
              put(m.instanceMatrix.array as Float32Array, i, w, h, D, _o.x, _o.y, _o.z);
              putAtlas(m, i, b.cover.uv, MATTE, 0);
            }
            {
              // the page under the lifted page group: body text
              const slot = this.innerSlotFor(b, "text");
              nInnerF = inner(this.innerFront, nInnerF, slot ? slot.uv : this.innerPlain, w, h, D);
            }
            if (b.spine.drawn) {
              // the spine spans the whole book: centred on the closed book's thickness
              const shift = (e.width - w) / 2;
              const m = this.spineMeshes[b.spine.slot.page];
              const i = nSpine[b.spine.slot.page]++;
              put(m.instanceMatrix.array as Float32Array, i, e.width, h, D, _o.x + r0x * shift, _o.y + r0y * shift, _o.z + r0z * shift);
              putAtlas(m, i, b.spine.uv, b.mat[0], b.mat[1]);
              if (this.readIds.has(e.id) && nRib < CAPACITY) {
                const ry = h - 32;
                const rx = shift + e.width * 0.18;
                put(ribM, nRib, Math.min(7, e.width * 0.3), 34, 1, _o.x + r0x * rx + r1x * ry + r2x * 0.4, _o.y + r0y * rx + r1y * ry + r2y * 0.4, _o.z + r0z * rx + r1z * ry + r2z * 0.4);
                ribC[nRib * 3] = b.rib.r;
                ribC[nRib * 3 + 1] = b.rib.g;
                ribC[nRib * 3 + 2] = b.rib.b;
                nRib++;
              }
            }
          } else if (rp.kind === "cover") {
            // a thin board: its print outside, plain paper inside, board-coloured edges
            put(bodyM, nBody, w, h, D, _o.x, _o.y, _o.z);
            bodyCol.set(b.col, nBody * 3);
            bodyBand.set(b.band, nBody * 3);
            bodySize.set(b.size, nBody * 4);
            bodySize[nBody * 4] = w;
            bodySize[nBody * 4 + 3] = 1;
            nBody++;
            if (!b.cover.drawn) this.lateBake(b, "cover");
            if (b.cover.drawn) {
              const m = this.coverMeshes[b.cover.slot.page];
              const i = nCover[b.cover.slot.page]++;
              put(m.instanceMatrix.array as Float32Array, i, w, h, D, _o.x, _o.y, _o.z);
              putAtlas(m, i, b.cover.uv, MATTE, 0);
            }
            {
              // the inside of the front cover: the title page
              const slot = this.innerSlotFor(b, "title");
              nInnerB = inner(this.innerBack, nInnerB, slot ? slot.uv : this.innerPlain, w, h, D);
            }
          } else {
            if (rp.kind === "fan") {
              // a fanned leaf: a sheet of text, both faces (no block: edge-on it would read as a dark line)
              const slot = this.innerSlotFor(b, "text");
              const uv = slot ? slot.uv : this.innerPlain;
              nInnerF = inner(this.innerFront, nInnerF, uv, w, h, D);
              nInnerB = inner(this.innerBack, nInnerB, uv, w, h, D);
              continue;
            }
            // the page group: page lines on its edges, the first page (a faint typeset title) on its face
            put(bodyM, nBody, w, h, D, _o.x, _o.y, _o.z);
            bodyCol.set(b.col, nBody * 3);
            bodyBand.set(b.band, nBody * 3);
            bodySize.set(b.size, nBody * 4);
            bodySize[nBody * 4] = w;
            bodySize[nBody * 4 + 3] = 0;
            nBody++;
            const slot = this.innerSlotFor(b, "text");
            nInnerF = inner(this.innerFront, nInnerF, slot ? slot.uv : this.innerPlain, w, h, D);
          }
        }
      }
    }
    this.updateDeskShadow();
    const n = finishAll(blank);
    return n;
  }


  /** The desk's book casts a soft shadow onto the desk: a dark plane behind it, down and to the right of it. */
  /** debug / tests: leave the desk's book and its shadow out of the picture (to measure the desk around it) */
  debugHideDesk = false;
  private updateDeskShadow() {
    const d = this.ground?.deskBook();
    if (!d || d.alpha <= 0.01 || this.debugHideDesk) {
      if (this.deskShadow) this.deskShadow.visible = false;
      return;
    }
    const m = this.deskShadowMesh();
    m.visible = true;
    const u = m.material.uniforms;
    u.uOpacity.value = DESK_SHADOW_OPACITY * d.alpha;
    // the book's footprint (cover width x height), the darkest just inside its edges, feathered
    // over DESK_SHADOW_FEATHER units (~12-20 px on screen) beyond them
    (u.uHalf.value as THREE.Vector2).set(d.w / 2, d.h / 2);
    (u.uSize.value as THREE.Vector2).set(d.w + 2 * DESK_SHADOW_FEATHER + 8, d.h + 2 * DESK_SHADOW_FEATHER + 8);
    // just behind the back board, nudged down and to the right (the light is top-left)
    const w = this.books.get(d.id)?.size[0] ?? 30;
    _o.set(-(w / 2 + 1.5), -5, -4).applyQuaternion(d.quat).add(d.pos);
    m.position.copy(_o);
    m.quaternion.copy(d.quat).multiply(_dq.setFromAxisAngle(_yAxis, Math.PI / 2));
    m.scale.set(1, 1, 1);
  }
  private deskShadowMesh() {
    let m = this.deskShadow;
    if (!m) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uSize: { value: new THREE.Vector2(1, 1) },
          uHalf: { value: new THREE.Vector2(0.5, 0.5) },
          uFeather: { value: DESK_SHADOW_FEATHER },
          uOpacity: { value: DESK_SHADOW_OPACITY },
          uColor: { value: new THREE.Color(0x000000) }, // black: on the charcoal table a tinted shadow would glow
        },
        vertexShader: `uniform vec2 uSize; varying vec2 vPos;
          void main() { vPos = position.xy * uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 0.0, 1.0); }`,
        fragmentShader: `uniform vec2 uHalf; uniform float uFeather; uniform float uOpacity; uniform vec3 uColor; varying vec2 vPos;
          void main() {
            vec2 q = abs(vPos) - uHalf;
            float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
            float a = 1.0 - smoothstep(-2.0, uFeather, d);
            gl_FragColor = vec4(uColor, a * uOpacity);
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
      });
      m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.renderOrder = -1;
      m.visible = false;
      this.deskShadow = m;
      this.root.add(m);
    }
    return m;
  }
  private putBlob(i: number, x: number, z: number, r2x: number, r2z: number, w: number, D: number, alpha: number, lift: number) {
    if (i >= CAPACITY) return;
    const a = this.blob.instanceMatrix.array as Float32Array;
    const grow = 1 + lift * 0.5;
    const sx = (w + 16) * grow;
    const sz = (D + 18) * grow;
    const o = i * 16;
    // the unit plane lies in x/z; turn it with the book (Ry only)
    a[o] = r2z * sx;
    a[o + 1] = 0;
    a[o + 2] = -r2x * sx;
    a[o + 3] = 0;
    a[o + 4] = 0;
    a[o + 5] = 1;
    a[o + 6] = 0;
    a[o + 7] = 0;
    a[o + 8] = r2x * sz;
    a[o + 9] = 0;
    a[o + 10] = r2z * sz;
    a[o + 11] = 0;
    a[o + 12] = x - r2x * (D / 2) + 12 * lift;
    a[o + 13] = 0.3;
    a[o + 14] = z - r2z * (D / 2) + 8 * lift;
    a[o + 15] = 1;
    (this.blob.geometry.getAttribute("iAlpha").array as Float32Array)[i] = alpha;
  }

  /**
   * Render the first view once, hidden (its programs are already compiled by
   * compile(); this uploads the small room textures and, on HIGH, builds the
   * shadow pass), so the first visible frame is cheap.
   */
  warmup(scene: THREE.Scene) {
    for (const h of this.hi) h.mesh.frustumCulled = false;
    this.warmRender(scene);
    this.renderer.render(scene, this.camera);
  }
  /**
   * Part of the start-up warm-up, before the shelf shows: one off-screen frame with the desk's
   * shadow, a hi-res cover and the inner pages drawn together, so the driver's own lazy
   * first-draw work (a 130 ms frame on D3D11) is done before anyone can click.
   */
  private warmRender(scene: THREE.Scene) {
    if (this.disposed) return;
    this.ensureInnerAtlas();
    const inst = [this.innerFront, this.innerBack].filter((m): m is THREE.InstancedMesh => !!m);
    const shadow = this.deskShadowMesh();
    shadow.visible = true;
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const hiWas = this.hi.map((h) => h.mesh.visible);
    const all = [this.body, ...this.spineMeshes, ...this.coverMeshes, ...this.backMeshes, ...this.plateMeshes, this.ribbon, this.blob, this.slab, ...inst];
    const allCounts = all.map((m) => m.count);
    const rt = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: true, stencilBuffer: false });
    try {
      r.setRenderTarget(rt);
      for (const h of this.hi) {
        h.mesh.visible = true;
        h.tex.needsUpdate = true;
      }
      for (const m of all) m.count = Math.max(1, m.count);
      r.render(scene, this.camera);
    } catch {
      /* nothing to warm */
    } finally {
      all.forEach((m, i) => (m.count = allCounts[i]));
      this.hi.forEach((h, i) => (h.mesh.visible = hiWas[i]));
      r.setRenderTarget(prevRT);
      rt.dispose();
    }
    shadow.visible = false;
  }
  /**
   * At idle after the shelf is up: the inner pages' plain print, and a second pass over the
   * programs (the start-up compile covers the desk and the hi-res covers already).
   */
  warmGround(scene: THREE.Scene) {
    if (this.disposed || !this.ready) return;
    this.ensureInnerAtlas();
    this.paintInnerPlain();
    this.deskShadowMesh();
    void this.compile(scene);
    this.engine.requestFrame();
  }

  /** GPU memory held by the face textures (bytes, with mipmaps), for the report. */
  textureBytes() {
    const page = (n: number) => n * n * 4 * 1.333;
    const hi = this.hi.reduce((sum, h) => sum + h.canvas.width * h.canvas.height * 4 * 1.333, 0);
    return (this.spineTex.length + this.coverTex.length) * page(this.spinePack.size) + (this.plateTex.length + (this.innerTex ? 1 : 0)) * page(this.platePack.size) + hi;
  }
  pageCounts() {
    return {
      spine: this.spineTex.length,
      cover: this.coverTex.length,
      plate: this.plateTex.length,
      rho: { spine: this.spineRho, cover: this.coverRho, hi: this.hiRho },
    };
  }

  /** After a WebGL context restore: re-allocate the atlases empty and bake every face again. */
  restore() {
    this.paintQueue = [];
    for (const b of this.books.values()) b.spine.drawn = b.cover.drawn = false;
    for (const f of this.plates.values()) f.drawn = false;
    for (const t of [...this.spineTex, ...this.coverTex, ...this.plateTex]) this.renderer.initTexture(t);
    for (const h of this.hi) {
      h.tex.needsUpdate = true;
      h.painted = null;
    }
    if (this.roomTex) for (const t of Object.values(this.roomTex)) t.needsUpdate = true;
    this.makeEnv();
    this.rebakeAll();
  }

  dispose() {
    this.disposed = true;
    this.imgQueue = [];
    this.paintQueue = [];
    this.disposeMeshes();
    for (const m of this.roomMeshes) m.geometry.dispose();
    if (this.roomMats) for (const m of Object.values(this.roomMats)) m.dispose();
    for (const t of [...this.spineTex, ...this.coverTex, ...this.plateTex]) t.dispose();
    if (this.roomTex) for (const t of Object.values(this.roomTex)) t.dispose();
    this.envTex?.dispose();
    if (this.deskShadow) {
      this.deskShadow.geometry.dispose();
      this.deskShadow.material.dispose();
    }
    this.host?.remove(this.root);
  }
}
