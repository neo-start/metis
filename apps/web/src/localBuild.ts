// FILE: localBuild.ts
// Purpose: Identify which local change the running Metis window was built from.
// Layer: shared UI constants + one DOM helper (no React)
// Exports: LocalBuildChange, LOCAL_BUILD_CHANGES, CURRENT_LOCAL_BUILD,
//   localBuildLabel, readRunningBundleId
//
// Metis loads the web bundle from disk per window, but a running window keeps the
// bundle it booted with — a rebuild is only visible after a restart. That makes
// "which change is actually running?" a real question, answered here twice:
//
//   1. `LOCAL_BUILD_CHANGES` — one entry per change to this fork, newest first.
//      Bump the number and prepend an entry with **every** change; Settings →
//      Advanced → About shows the newest number and the full list.
//   2. `readRunningBundleId()` — the content hash in the loaded `index-<hash>.js`
//      file name. It changes whenever the built app code changes, including
//      changes nobody recorded in the list above, so it is the honest answer for
//      "is this window older than what is on disk?".
//
// The ledger starts at 2026-09-28; changes made before that day are not listed.

export interface LocalBuildChange {
  /** Monotonic local change number, newest entry highest. */
  readonly change: number;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** One short line describing the change. */
  readonly summary: string;
}

/** Newest first. Prepend an entry and bump `change` for every change. */
export const LOCAL_BUILD_CHANGES: readonly LocalBuildChange[] = [
  {
    change: 7,
    date: "2026-09-28",
    summary:
      "Sidebar thread rows: title text is the leftmost element; provider avatar moved to the trailing side.",
  },
  {
    change: 6,
    date: "2026-09-28",
    summary:
      "The Build row warns when the bundle on disk is newer than this window and offers a Restart button.",
  },
  {
    change: 5,
    date: "2026-09-28",
    summary: "Settings → About shows the running build number and the list of local changes.",
  },
  {
    change: 4,
    date: "2026-09-28",
    summary:
      "Sidebar usage rows use the app tooltip instead of the system `title` tooltip (300ms, no more misses).",
  },
  {
    change: 3,
    date: "2026-09-28",
    summary: "Tooltip hover delay drops from the Base UI default 600ms to 300ms.",
  },
  {
    change: 2,
    date: "2026-09-28",
    summary: "Fixed the whole-page flicker caused by the Claude compaction auto-answer loop.",
  },
  {
    change: 1,
    date: "2026-09-28",
    summary:
      "Provider icon tooltips: model picker tabs show the signed-in account, and 13 icon-only spots gained tooltips.",
  },
];

const FALLBACK_BUILD_CHANGE: LocalBuildChange = { change: 0, date: "", summary: "" };

/** The change this build was made from. */
export const CURRENT_LOCAL_BUILD: LocalBuildChange =
  LOCAL_BUILD_CHANGES[0] ?? FALLBACK_BUILD_CHANGE;

/** Human label for a ledger entry, e.g. `build 5`. */
export function localBuildLabel(entry: LocalBuildChange = CURRENT_LOCAL_BUILD): string {
  return entry.change > 0 ? `build ${entry.change}` : "build unknown";
}

/**
 * Content hash of the app entry bundle this window loaded.
 *
 * Vite names the entry chunk `index-<hash>.js` and every other chunk's file name
 * is referenced from it, so the hash moves whenever any built app code changes.
 * Returns null in the dev server and in any environment without that script tag.
 */
export function readRunningBundleId(): string | null {
  if (typeof document === "undefined") return null;
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="index-"]');
  const match = script?.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return match?.[1] ?? null;
}

/**
 * Entry bundle id of the build currently served from disk — what a restart would
 * load. Returns null when the shell cannot be read (dev server, offline).
 *
 * The request is cache-busted on purpose: the answer only matters when it differs
 * from the running bundle, and a cached shell would always look identical.
 */
export async function fetchServedBundleId(signal?: AbortSignal): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const base = import.meta.env.BASE_URL;
  for (const path of [`${base}index.html`, base]) {
    try {
      const url = new URL(path, document.baseURI);
      url.searchParams.set("build-check", Date.now().toString());
      const response = await fetch(url, { cache: "no-store", signal: signal ?? null });
      if (!response.ok) continue;
      const match = (await response.text()).match(/index-([A-Za-z0-9_-]+)\.js/);
      if (match?.[1]) return match[1];
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}
