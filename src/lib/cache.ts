import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SuiTransactionTrace } from "./types.js";

const CACHE_DIR = process.env.CHASE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase");

function ensureDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(digest: string): string {
  return path.join(CACHE_DIR, `${digest}.json`);
}

export function loadTrace(digest: string): SuiTransactionTrace | null {
  const p = cachePath(digest);
  if (!fs.existsSync(p)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.balanceChanges = (raw.balanceChanges ?? []).map((b: any) => ({
      ...b,
      amount: BigInt(b.amount),
    }));
    raw.ptbCommands = (raw.ptbCommands ?? []).map((c: any) => ({ ...c }));
    raw.objectChanges = (raw.objectChanges ?? []).map((o: any) => ({ ...o }));
    raw.events = (raw.events ?? []).map((e: any) => ({ ...e }));
    // default success to true for older cached traces
    if (typeof raw.success !== "boolean") raw.success = true;
    return raw as SuiTransactionTrace;
  } catch {
    return null;
  }
}

export function saveTrace(trace: SuiTransactionTrace): void {
  try {
    ensureDir();
    const serializable = {
      ...trace,
      balanceChanges: trace.balanceChanges.map((b) => ({
        ...b,
        amount: b.amount.toString(),
      })),
      raw: undefined,
    };
    fs.writeFileSync(cachePath(trace.digest), JSON.stringify(serializable));
  } catch {
    // cache write failure is non-fatal
  }
}

export function clearCache(): number {
  if (!fs.existsSync(CACHE_DIR)) return 0;
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(CACHE_DIR, f));
    } catch {}
  }
  return files.length;
}

export function cacheDir(): string {
  return CACHE_DIR;
}
