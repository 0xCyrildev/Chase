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

export function clearCache(): number {
  let count = 0;
  for (const network of ["mainnet", "testnet", "devnet"] as CacheNetwork[]) {
    const dir = networkDir(network);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(dir, f));
        count++;
      } catch {}
    }
  }
  return count;
}

export function cacheDir(): string {
  return CACHE_DIR;
}
