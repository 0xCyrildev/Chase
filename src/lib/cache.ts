import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SuiTransactionTrace } from "./types.js";
import { assertDigest } from "./digest.js";

export type CacheNetwork = "mainnet" | "testnet" | "devnet";

const CACHE_DIR = process.env.CHASE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase");

/**
 * Traces are namespaced by network. The same digest requested on two networks must never
 * resolve to the same record, and a cached trace must never be reported as coming from a
 * network it was not fetched from.
 */
function networkDir(network: CacheNetwork): string {
  return path.join(CACHE_DIR, network);
}

function cachePath(network: CacheNetwork, digest: string): string {
  return path.join(networkDir(network), `${assertDigest(digest)}.json`);
}

export function loadTrace(
  digest: string,
  network: CacheNetwork
): SuiTransactionTrace | null {
  const p = cachePath(network, digest);
  if (!fs.existsSync(p)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw.digest !== digest) {
      console.error(`[chase] ignoring cached trace at ${p}: digest does not match`);
      return null;
    }
    if (raw.network && raw.network !== network) {
      console.error(
        `[chase] ignoring cached trace at ${p}: recorded on ${raw.network}, requested on ${network}`
      );
      return null;
    }

    raw.balanceChanges = (raw.balanceChanges ?? []).map((b: any) => ({
      ...b,
      amount: BigInt(b.amount),
    }));
    // default success to true for older cached traces
    if (typeof raw.success !== "boolean") raw.success = true;
    raw.network = network;
    return raw as SuiTransactionTrace;
  } catch {
    return null;
  }
}

export function saveTrace(trace: SuiTransactionTrace): void {
  try {
    const network = trace.network ?? "mainnet";
    fs.mkdirSync(networkDir(network), { recursive: true });
    const serializable = {
      ...trace,
      balanceChanges: trace.balanceChanges.map((b) => ({
        ...b,
        amount: b.amount.toString(),
      })),
      raw: undefined,
    };
    fs.writeFileSync(cachePath(network, trace.digest), JSON.stringify(serializable), {
      mode: 0o600,
    });
  } catch {
    // cache write failure is non-fatal
  }
}

export interface CacheClearing {
  traces: number;
  /** Traces written before records were namespaced by network; `loadTrace` cannot read them. */
  unreachableTraces: number;
  checkpoints: number;
}

function unlinkJson(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
      n++;
    } catch {}
  }
  return n;
}

export function clearCache(): CacheClearing {
  const counts: CacheClearing = { traces: 0, unreachableTraces: 0, checkpoints: 0 };

  for (const network of ["mainnet", "testnet", "devnet"] as CacheNetwork[]) {
    counts.traces += unlinkJson(networkDir(network));
  }

  // Anything left as a loose file at the cache root is either a pre-namespacing trace (no
  // `network` field, so loadTrace never resolves it) or a checkpoint listing. Both used to
  // survive `--clear`, which then reported a wiped cache while they stayed on disk.
  // signatures.json is excluded: the signature cache owns that path and clears itself.
  if (fs.existsSync(CACHE_DIR)) {
    for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (entry.name === "signatures.json") continue;
      try {
        fs.unlinkSync(path.join(CACHE_DIR, entry.name));
        counts.unreachableTraces++;
      } catch {}
    }

    const checkpointDir = path.join(CACHE_DIR, "checkpoints");
    counts.checkpoints = unlinkJson(checkpointDir);
    try {
      fs.rmSync(checkpointDir, { recursive: true, force: true });
    } catch {}
  }

  return counts;
}

export function cacheDir(): string {
  return CACHE_DIR;
}
