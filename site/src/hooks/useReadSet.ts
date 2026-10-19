import { useSyncExternalStore } from "react";

/**
 * Which essays this visitor has opened via Read / Watch / archived links.
 * Stored in localStorage under `ir:read` as an array of ids. Every access is
 * guarded, so the site works (with an in-memory set) when storage is blocked.
 */
const KEY = "ir:read";
const EMPTY: ReadonlySet<string> = new Set();

let cache: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function load(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function save(set: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // storage unavailable (private mode, blocked, full): keep the in-memory state
  }
}

function getSnapshot(): ReadonlySet<string> {
  if (!cache) cache = load();
  return cache;
}

/** One module-level listener for other tabs' changes, shared by all subscribers. */
function onStorage(e: StorageEvent) {
  if (e.key === null || e.key === KEY) {
    cache = load();
    listeners.forEach((l) => l());
  }
}

function subscribe(onChange: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setRead(id: string, read: boolean) {
  const current = getSnapshot();
  if (current.has(id) === read) return;
  const next = new Set(current);
  if (read) next.add(id);
  else next.delete(id);
  cache = next;
  save(next);
  listeners.forEach((l) => l());
}

/** The set of read essay ids (stable identity until it changes). */
export function useReadSet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
