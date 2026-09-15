import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Violation } from "../lib/types.js";

const CACHE_DIR = process.env.CHASE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase");
const HISTORY_FILE = path.join(CACHE_DIR, "triage-history.json");

export type History = Record<string, number>;

function ensureDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function loadHistory(): History {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveHistory(h: History): void {
  try {
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
  } catch {
    // non-fatal
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
  return h[signature(v)] ?? 0;
}

export function recordViolations(violations: Violation[]): void {
  const h = loadHistory();
  for (const v of violations) {
    const sig = signature(v);
    h[sig] = (h[sig] ?? 0) + 1;
  }
  saveHistory(h);
}
