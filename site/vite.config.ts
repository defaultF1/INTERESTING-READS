import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * BASE_PATH lets the site live under a sub-path, e.g. example.com/reads/.
 * Accepts "/reads/", "/reads", "reads" or a full URL. Defaults to "/".
 * Read from the shell environment first, then from .env / .env.production.
 */
function normalizeBase(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  // Git Bash (MSYS) rewrites "/reads/" into "C:/Program Files/Git/reads/".
  const msys = value.match(/^[A-Za-z]:[\\/](?:.*[\\/])?(?:Git|msys64|msys32)[\\/](.*)$/i);
  if (msys) value = msys[1];
  else if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`BASE_PATH looks like a Windows path (${value}). Use BASE_PATH=reads (no leading slash).`);
  }
  if (!value || value === "/") return "/";
  if (/^https?:\/\//i.test(value) || value === "./") return value.endsWith("/") ? value : `${value}/`;
  return `/${value.replace(/^\/+|\/+$/g, "")}/`;
}

/**
 * rapier3d-compat's own init() hands its inlined WASM bytes to the wasm-bindgen loader in
 * the older positional form, which logs a deprecation warning on every load ("using
 * deprecated parameters for the initialization function"). Nothing on our side can pass
 * the object form through it, so the bundle drops that one warning.
 */
function quietRapierInit(): Plugin {
  const WARN = /console\.warn\((["'])using deprecated parameters for (?:the initialization function|`initSync\(\)`); pass a single object instead\1\)/g;
  return {
    name: "quiet-rapier-init",
    transform(code, id) {
      if (!id.includes("rapier3d-compat")) return null;
      if (!WARN.test(code)) return null;
      WARN.lastIndex = 0;
      return { code: code.replace(WARN, "void 0"), map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: normalizeBase(process.env.BASE_PATH ?? env.BASE_PATH),
    plugins: [react(), tailwindcss(), quietRapierInit()],
    // (the simulation worker is bundled separately, with its own plugin list)
    // (a classic script, not a module worker: Firefox before 114 and Safari before 15 cannot
    // start a module worker; the bundle is one file either way)
    worker: { format: "iife", plugins: () => [quietRapierInit()] },
    // The 3D shelf's dependencies are imported lazily; pre-bundle them up front so the
    // dev server doesn't discover (and re-optimise) them mid-session.
    optimizeDeps: {
      include: ["three", "three/examples/jsm/environments/RoomEnvironment.js", "@react-three/fiber", "@dimforge/rapier3d-compat"],
    },
    build: {
      // Two big lazy chunks, by design: the WebGL shelf (three.js + R3F, ~920 kB /
      // ~250 kB gzip, loaded in parallel with the first render) and the floor's
      // physics (Rapier with its WASM inlined, ~2.2 MB / ~830 kB gzip, prefetched
      // at idle once the shelf is up).
      chunkSizeWarningLimit: 2300,
    },
  };
});
