import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Where `chase watch` got to.
 *
 * Deliberately NOT under CHASE_CACHE_DIR: the fixture suites point that variable at
 * `test-cases/fixtures`, so a state file written there would be edited by the tests that read it,
 * and "a state store a test mutates is not a fixture" is the same argument `../triage/history.ts`
 * makes about novelty counters. Mutable state goes to `$XDG_DATA_HOME`, per network, and is
 * disableable by setting the override to the empty string in both directions.
 */
export type CursorNetwork = "mainnet" | "testnet" | "devnet";

export interface CursorEntry {
  /**
   * The NEXT checkpoint to attempt — equivalent to "every checkpoint before this one had its
   * transactions attempted", modulo the gaps recorded beside it. A string because JSON has no
   * bigint.
   */
  checkpoint: string;
  savedAt: string;
  /** Checkpoints that were attempted and could not be read. Gaps are covered, not skipped. */
  gaps: string[];
}

const MAX_GAPS = 50;

export const CURSOR_NETWORKS: CursorNetwork[] = ["mainnet", "testnet", "devnet"];

export function cursorPath(): string | null {
  const override = process.env.CHASE_WATCH_CURSOR_FILE;
  if (override !== undefined) {
    if (override === "") return null;
    // expandHomeDir landed after this package's minimum Node, so do it here.
    return override.startsWith("~/") ? path.join(os.homedir(), override.slice(2)) : override;
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "chase", "watch-cursor.json");
}

type CursorFileRead =
  | { kind: "absent" | "ok"; all: Record<string, CursorEntry> }
  | { kind: "error"; message: string };

function readCursorFile(p: string): CursorFileRead {
  if (!fs.existsSync(p)) return { kind: "absent", all: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return { kind: "ok", all: parsed as Record<string, CursorEntry> };
  } catch (err: any) {
    return { kind: "error", message: String(err?.message ?? err) };
  }
}

function readAll(): Record<string, CursorEntry> {
  const p = cursorPath();
  if (!p) return {};
  const read = readCursorFile(p);
  if (read.kind === "error") {
    // A silent fallback here would resume from tip-2 and make the uncovered range disappear, which
    // is the failure this whole file exists to prevent.
    console.error(
      `[chase] could not read the saved cursor (${p}): ${read.message}. ` +
        `Starting fresh, and the gap since your last run is not covered.`
    );
    return {};
  }
  return read.all;
}

/** A stored record the reader cannot use is `null`, never a guessed position. */
function coerceEntry(raw: any): CursorEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (!/^\d+$/.test(String(raw.checkpoint))) return null;
  return {
    checkpoint: String(raw.checkpoint),
    savedAt: String(raw.savedAt ?? "unknown"),
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(String) : [],
  };
}

export function loadCursor(network: CursorNetwork): CursorEntry | null {
  return coerceEntry(readAll()[network]);
}

/** Written as tmp + rename: a torn cursor reads as no cursor, and resumes from tip-2 in silence. */
function writeAll(all: Record<string, CursorEntry>): string | null {
  const p = cursorPath();
  if (!p) return "cursor saving is disabled (CHASE_WATCH_CURSOR_FILE='')";
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, p);
    return null;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}

export function saveCursor(network: CursorNetwork, checkpoint: bigint, gaps: string[] = []): void {
  const p = cursorPath();
  if (!p) return;
  const all = readAll();
  all[network] = {
    checkpoint: checkpoint.toString(),
    savedAt: new Date().toISOString(),
    gaps: gaps.slice(-MAX_GAPS),
  };
  // A cursor that will not write degrades to "no cursor", which every caller must then say. The run
  // keeps going; `--status` and the closing summary read the position back off disk, so what they
  // print is what was stored rather than what this call intended.
  void writeAll(all);
}

export type CursorState = "saved" | "absent" | "unreadable" | "disabled";

export interface CursorStatus {
  path: string | null;
  network: CursorNetwork;
  state: CursorState;
  entry: CursorEntry | null;
  /** Why a record could not be used, when it could not. */
  detail?: string;
}

/**
 * Read-only view of the stored position, for `chase watch --status` and `chase cache`. It reports
 * the four situations a cursor can be in rather than collapsing "nothing saved" and "unreadable"
 * into one: the first means start fresh, the second means somebody should look at this file.
 */
export function cursorStatus(network: CursorNetwork): CursorStatus {
  const path = cursorPath();
  if (!path) return { path: null, network, state: "disabled", entry: null };
  const read = readCursorFile(path);
  if (read.kind === "error") {
    return { path, network, state: "unreadable", entry: null, detail: read.message };
  }
  const raw = read.all[network];
  if (raw === undefined) {
    return { path, network, state: "absent", entry: null };
  }
  const entry = coerceEntry(raw);
  if (!entry) {
    return {
      path,
      network,
      state: "unreadable",
      entry: null,
      detail: `the stored record has no usable checkpoint field`,
    };
  }
  return { path, network, state: "saved", entry };
}

/** One line per network, for `chase cache`. Derived from the same read as `--status`, not a second copy. */
export function describeCursor(network: CursorNetwork): string {
  const s = cursorStatus(network);
  if (s.state === "disabled") return `${network}: no cursor file (saving is disabled)`;
  if (s.state === "absent") return `${network}: nothing saved`;
  if (s.state === "unreadable" || !s.entry) return `${network}: stored record unusable (${s.detail})`;
  return (
    `${network}: next checkpoint ${s.entry.checkpoint} (saved ${s.entry.savedAt}` +
    `${s.entry.gaps.length ? `, ${s.entry.gaps.length} gap(s)` : ""})`
  );
}

export interface CursorRemoval {
  path: string | null;
  removed: boolean;
  entry: CursorEntry | null;
  /** Set when nothing was removed because the store could not be read or written. */
  detail?: string;
}

/**
 * Forget one network's position. Other networks in the same file are left alone, and a file this
 * cannot parse is left on disk: deleting a document we could not read would also delete whatever
 * the other networks had saved in it, which is not what a reset asks for.
 */
export function clearCursor(network: CursorNetwork): CursorRemoval {
  const path = cursorPath();
  if (!path) {
    return { path: null, removed: false, entry: null, detail: "cursor saving is disabled, so there is nothing to reset" };
  }
  const read = readCursorFile(path);
  if (read.kind === "error") {
    return { path, removed: false, entry: null, detail: read.message };
  }
  const raw = read.all[network];
  if (raw === undefined) return { path, removed: false, entry: null };
  const entry = coerceEntry(raw);
  delete read.all[network];
  const failed = writeAll(read.all);
  if (failed) return { path, removed: false, entry, detail: failed };
  return { path, removed: true, entry };
}

export interface WatchStart {
  cursor: bigint;
  /** One of four named outcomes. A reader must always know which one they got. */
  why: string;
  gaps: string[];
  /** Set when the stored cursor cannot be used at all; the run must not quietly fall back. */
  exitCode?: number;
  remedy?: string;
}

/**
 * Decide where a watch run begins. Pure, so every branch is testable without a network:
 *
 *   --from            > explicit wins, and the stored cursor is NOT rewound by it
 *   stored cursor     > resume from it, if it is still inside what the endpoint can serve
 *   tip - 2           > only when there is genuinely no usable cursor
 *
 * A stored cursor below the retention floor exits rather than clamping: clamping turns "resume"
 * into an unasked-for backfill over weeks of history, and printing a number is not consent.
 */
export function resolveWatchStart(args: {
  flag?: bigint;
  saved: CursorEntry | null;
  current: bigint;
  lowest: bigint;
  path?: string | null;
}): WatchStart {
  const { flag, saved, current, lowest } = args;
  const where = args.path === undefined ? cursorPath() : args.path;

  if (flag !== undefined) {
    const note = saved
      ? `; --from given, so the stored cursor stays at ${saved.checkpoint} (not rewound)`
      : "; no stored cursor to update";
    return { cursor: flag, why: `STARTING FROM --from${note}`, gaps: saved?.gaps ?? [] };
  }

  if (saved) {
    const at = BigInt(saved.checkpoint);
    if (at < lowest) {
      return {
        cursor: at,
        why: `CURSOR UNUSABLE (saved checkpoint ${at} is below this endpoint's retention floor ${lowest})`,
        gaps: saved.gaps,
        exitCode: 2,
        remedy:
          `${(at - lowest) * -1n} checkpoint(s) are unrecoverable from here. ` +
          `Run with --from ${lowest} to backfill on purpose, or delete ${where ?? "the cursor file"} to resume from the tip.`,
      };
    }
    if (at > current) {
      return {
        cursor: at,
        why: `CURSOR UNUSABLE (saved checkpoint ${at} is ahead of this endpoint's tip ${current})`,
        gaps: saved.gaps,
        exitCode: 2,
        remedy:
          `The endpoint is behind, or this network was wiped. Delete ${where ?? "the cursor file"} ` +
          `to start over, or point SUI_RPC_URL at a node that is caught up.`,
      };
    }
    const behind = current - at;
    return {
      cursor: at,
      why: `RESUMING FROM SAVED CURSOR (last saved ${saved.savedAt}, ${behind} checkpoint(s) behind the tip)`,
      gaps: saved.gaps,
    };
  }

  return {
    cursor: current - 2n,
    why: `TIP-2 (no usable cursor${where ? "" : "; cursor disabled by CHASE_WATCH_CURSOR_FILE=''"}), starting at ${current - 2n}`,
    gaps: [],
  };
}
