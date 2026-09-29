import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Violation } from "../lib/types.js";

/**
 * Triage history is global mutable state, so it deliberately does NOT live in the trace cache
 * directory. `CHASE_CACHE_DIR` is also the offline fixture directory the regression suites run
 * against, and a file the analysis reads cannot double as a counter store: the counters would
 * drift with every run, and once a signature passed `noveltyPenalty.threshold` the −15 penalty
 * would change a fixture's expected tier. A store a test mutates is not a fixture.
 *
 * Resolution order:
 *   1. `CHASE_HISTORY_FILE` — explicit path; an explicitly empty value disables history
 *      completely (reads return nothing, writes are dropped), which is how a suite opts out.
 *   2. otherwise the user data dir (`XDG_DATA_HOME`, else `~/.local/share`), never the cache dir.
 *
 * Counters are namespaced per network: a testnet signature must not age out a mainnet one.
 */
export type History = Record<string, number>;
export type NetworkHistory = Record<string, History>;

const EMPTY: History = {};

function defaultDataDir(): string {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/** `null` means history is disabled by explicit configuration. */
export function historyFile(): string | null {
  const override = process.env.CHASE_HISTORY_FILE;
  if (override !== undefined) return override === "" ? null : override;
  return path.join(defaultDataDir(), "chase", "triage-history.json");
}

function networkKey(network: string): string {
  return String(network ?? "unknown").toLowerCase();
}

function readFile(): NetworkHistory {
  const file = historyFile();
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    // A pre-namespaced file (a flat signature -> count map) is not readable as per-network data;
    // treat it as absent rather than mis-attributing every counter.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as NetworkHistory;
  } catch {
    return {};
  }
}

export function loadHistory(network: string): History {
  const perNetwork = readFile()[networkKey(network)];
  return perNetwork && typeof perNetwork === "object" ? perNetwork : EMPTY;
}

export function saveHistory(network: string, h: History): void {
  const file = historyFile();
  if (!file) return; // history disabled
  try {
    const all = readFile();
    all[networkKey(network)] = h;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    // non-fatal: a missing counter store only means findings score as novel
  }
}

function signature(v: Violation): string {
  const e = v.evidence ?? {};
  const parts = [
    v.type,
    (e as any).package ?? "",
    (e as any).module ?? "",
    (e as any).function ?? "",
  ];
  return crypto.createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 16);
}

export function countSignature(h: History, v: Violation): number {
  const n = h[signature(v)];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Recording is a state mutation and is only ever done on request (see `TriageOptions.record`):
 * analysis, the MCP tool and the agent paths must stay read-only so a run cannot accumulate.
 */
export function recordViolations(violations: Violation[], network: string): void {
  if (violations.length === 0 || !historyFile()) return;
  const h = loadHistory(network);
  for (const v of violations) {
    const sig = signature(v);
    h[sig] = (h[sig] ?? 0) + 1;
  }
  saveHistory(network, h);
}

export function recordFindings(
  findings: readonly { violation: Violation; network: string }[]
): void {
  const byNetwork = new Map<string, Violation[]>();
  for (const f of findings) {
    const key = networkKey(f.network);
    const bucket = byNetwork.get(key);
    if (bucket) bucket.push(f.violation);
    else byNetwork.set(key, [f.violation]);
  }
  for (const [network, violations] of byNetwork) recordViolations(violations, network);
}
