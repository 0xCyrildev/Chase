import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_DIR = path.join(
  process.env.CHASE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase"),
  "checkpoints"
);

const TTL_MS = 5 * 60 * 1000;

interface CachedCheckpoint {
  fetchedAt: number;
  digests: string[];
}

function cachePath(seq: bigint): string {
  return path.join(CACHE_DIR, `${seq}.json`);
}

export function loadCheckpoint(seq: bigint): string[] | null {
  const p = cachePath(seq);
  if (!fs.existsSync(p)) return null;

  try {
    const data: CachedCheckpoint = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Date.now() - data.fetchedAt > TTL_MS) return null;
    return data.digests;
  } catch {
    return null;
  }
}

export function saveCheckpoint(seq: bigint, digests: string[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const data: CachedCheckpoint = {
      fetchedAt: Date.now(),
      digests,
    };
    fs.writeFileSync(cachePath(seq), JSON.stringify(data));
  } catch {
    // cache write failures are non-fatal
  }
}
