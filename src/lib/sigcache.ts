import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_DIR = process.env.CHASE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase");
const SIG_CACHE_FILE = path.join(CACHE_DIR, "signatures.json");

type SigCache = Record<string, boolean>;

let inMemory: SigCache | null = null;

function ensureDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function load(): SigCache {
  if (inMemory) return inMemory;
  if (!fs.existsSync(SIG_CACHE_FILE)) {
    inMemory = {};
    return inMemory;
  }
  try {
    inMemory = JSON.parse(fs.readFileSync(SIG_CACHE_FILE, "utf8"));
    return inMemory!;
  } catch {
    inMemory = {};
    return inMemory;
  }
}

function persist(): void {
  if (!inMemory) return;
  try {
    ensureDir();
    fs.writeFileSync(SIG_CACHE_FILE, JSON.stringify(inMemory));
  } catch {
    // write failure non-fatal
  }
}

export function getSignature(key: string): boolean | undefined {
  return load()[key];
}

export function setSignature(key: string, value: boolean): void {
  load()[key] = value;
  persist();
}

export function clearSignatureCache(): number {
  const cache = load();
  const count = Object.keys(cache).length;
  inMemory = {};
  if (fs.existsSync(SIG_CACHE_FILE)) {
    try {
      fs.unlinkSync(SIG_CACHE_FILE);
    } catch {}
  }
  return count;
}

export function signatureCacheSize(): number {
  return Object.keys(load()).length;
}
