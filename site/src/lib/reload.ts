const KEY = "ir:chunk-reload";

/**
 * A lazily loaded chunk failed to arrive: most often a new version was deployed under
 * an open tab, whose page still asks for the old file names. Reload the page once (the
 * fresh page names the new files); a second failure within a minute is left to the
 * caller's fallback, so a broken deploy never loops.
 */
export function reloadOnceOnChunkFailure(what: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  console.warn(`Interesting Reads: the ${what} failed to load (a new version was deployed?); reloading once.`);
  window.location.reload();
  return true;
}
