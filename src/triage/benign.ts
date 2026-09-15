import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenignMatch } from "./types.js";
import { Violation } from "../lib/types.js";

interface Pattern {
  pattern: string;
  reason: string;
  suppresses: string[];
}

interface BenignPatterns {
  exact: Pattern[];
  heuristic: Pattern[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_FILE = path.join(__dirname, "benign-patterns.json");

let cache: BenignPatterns | null = null;

function load(): BenignPatterns {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf8"));
    return cache!;
  } catch {
    cache = { exact: [], heuristic: [] };
    return cache;
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function findBenignMatch(violation: Violation): BenignMatch | undefined {
  const evidence = (violation.evidence ?? {}) as any;
  const candidates: string[] = [];

  // Standard shape: pkg / module / function separately
  if (evidence.package && evidence.module && evidence.function) {
    candidates.push(`${evidence.package}::${evidence.module}::${evidence.function}`);
  }

  // REENTRANCY_PATTERN shape: full pkg::mod::fn in `function`
  if (typeof evidence.function === "string" && evidence.function.includes("::")) {
    candidates.push(evidence.function);
  }

  // REPEATED_MODULE_CALLS shape: module holds `pkg::mod`
  if (typeof evidence.module === "string" && evidence.module.includes("::")) {
    candidates.push(`${evidence.module}::*`);
  }

  // Fallback: bare module name
  if (typeof evidence.module === "string" && !evidence.module.includes("::")) {
    candidates.push(`*::${evidence.module}::*`);
  }

  const patterns = load();

  for (const candidate of candidates) {
    for (const p of patterns.exact) {
      if (globToRegex(p.pattern).test(candidate) && p.suppresses.includes(violation.type)) {
        return { kind: "exact", pattern: p.pattern, reason: p.reason };
      }
    }
  }

  for (const candidate of candidates) {
    for (const p of patterns.heuristic) {
      if (globToRegex(p.pattern).test(candidate) && p.suppresses.includes(violation.type)) {
        return { kind: "heuristic", pattern: p.pattern, reason: p.reason };
      }
    }
  }

  return undefined;
}
