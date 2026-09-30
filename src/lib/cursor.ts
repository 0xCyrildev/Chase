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

function readAll(): Record<string, CursorEntry> {
  const p = cursorPath();
  if (!p || !fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed;
  } catch (err: any) {
    // A silent fallback here would resume from tip-2 and make the uncovered range disappear, which
    // is the failure this whole file exists to prevent.
    console.error(
      `[chase] could not read the saved cursor (${p}): ${err?.message ?? err}. ` +
        `Starting fresh — the gap since your last run is not covered.`
    );
    return {};
  }
}

export function loadCursor(network: CursorNetwork): CursorEntry | null {
  const entry = readAll()[network];
  if (!entry || !/^\d+$/.test(String(entry.checkpoint))) return null;
  return {
    checkpoint: String(entry.checkpoint),
    savedAt: String(entry.savedAt ?? "unknown"),
    gaps: Array.isArray(entry.gaps) ? entry.gaps.map(String) : [],
  };
}

/** Written as tmp + rename: a torn cursor reads as no cursor, and resumes from tip-2 in silence. */
export function saveCursor(network: CursorNetwork, checkpoint: bigint, gaps: string[] = []): void {
  const p = cursorPath();
  if (!p) return;
  try {
    const all = readAll();
    all[network] = {
      checkpoint: checkpoint.toString(),
      savedAt: new Date().toISOString(),
      gaps: gaps.slice(-MAX_GAPS),
    };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    // A cursor that will not write degrades to "no cursor", which every caller must then say.
  }
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
