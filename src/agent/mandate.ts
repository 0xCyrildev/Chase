import fs from "node:fs";
import { Mandate } from "./types.js";
import { isDigest } from "../lib/digest.js";

/**
 * A digest list is one per line, `#` for comments — the same shape `chase batch` accepts, so an
 * analyst can pipe one into the other without a converter.
 */
export function readDigestList(file: string, label = "--txs"): string[] {
  if (!fs.existsSync(file)) throw new Error(`${label} file not found: ${file}`);
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) throw new Error(`${label} file holds no digests: ${file}`);
  // isDigest is a type guard, so the negative branch narrows to never[]; String() keeps the message
  // buildable without weakening the check.
  const bad: string[] = lines.filter((l) => !isDigest(l));
  if (bad.length > 0) {
    throw new Error(`${label} file contains ${bad.length} invalid digest(s), e.g. ${String(bad[0]).slice(0, 60)}`);
  }
  return lines;
}

const DEFAULT_BUDGET = {
  maxRpcCalls: 200,
  maxLlmCalls: 10,
  maxLlmTokens: 50000,
  maxWallMs: 15 * 60 * 1000,
};

const DEFAULT_MANDATE: Mandate = {
  target: "",
  checkpoints: 20,
  goal: "detect any suspicious activity",
  budget: DEFAULT_BUDGET,
};

/**
 * A budget limit that parses to NaN disables every comparison inside Budget silently, which
 * turns a bounded agent run into an unbounded one. Junk input is rejected instead.
 */
function positiveInt(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be a whole number, got: ${value}`);
    }
    if (value <= 0) {
      throw new Error(`${label} must be positive, got: ${value}`);
    }
    return value;
  }

  // parseInt("1e9") is 1 and parseInt("abc") is NaN, so a numeric string is checked for shape
  // before it is converted. Agents write exponent notation in JSON.
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a whole number of at least 1, got: ${text || "(empty)"}`);
  }
  return Number.parseInt(text, 10);
}

function optionalPositiveInt(
  value: string | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined || value === "") return fallback;
  return positiveInt(value, label);
}

function optionalNonNegativeInt(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a whole number of at least 0, got: ${text || "(empty)"}`);
  }
  return Number.parseInt(text, 10);
}

export function loadMandate(path?: string): Mandate {
  if (!path) return { ...DEFAULT_MANDATE };

  if (!fs.existsSync(path)) {
    throw new Error(`Mandate file not found: ${path}`);
  }

  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return validateMandate({
    ...DEFAULT_MANDATE,
    ...raw,
    // A mandate that sets only one budget field must not drop the other three caps.
    budget: { ...DEFAULT_BUDGET, ...(raw.budget ?? {}) },
  });
}

export function validateMandate(m: Mandate): Mandate {
  if (!m.target || typeof m.target !== "string") {
    throw new Error("Mandate requires a target (package ID or name)");
  }
  if (m.txs !== undefined) {
    if (!Array.isArray(m.txs) || m.txs.length === 0) {
      throw new Error("Mandate txs must be a non-empty list of digests");
    }
    const bad = m.txs.filter((d) => !isDigest(d));
    if (bad.length > 0) {
      throw new Error(`Mandate txs contains ${bad.length} invalid digest(s), e.g. ${String(bad[0]).slice(0, 60)}`);
    }
  }
  m.checkpoints = positiveInt(m.checkpoints, "Mandate checkpoints");
  m.budget.maxRpcCalls = positiveInt(m.budget.maxRpcCalls, "Mandate budget.maxRpcCalls");
  m.budget.maxLlmCalls = positiveInt(m.budget.maxLlmCalls, "Mandate budget.maxLlmCalls");
  m.budget.maxLlmTokens = positiveInt(m.budget.maxLlmTokens, "Mandate budget.maxLlmTokens");
  m.budget.maxWallMs = positiveInt(m.budget.maxWallMs, "Mandate budget.maxWallMs");
  if (
    m.budget.reserveForJudge !== undefined &&
    m.budget.reserveForJudge !== null
  ) {
    const r = m.budget.reserveForJudge;
    // 0 is a legitimate value: it means the operator wants no reserve. Junk is still rejected,
    // because a NaN here silently disables the scan ceiling comparison.
    if (!Number.isInteger(r) || r < 0) {
      throw new Error(
        `Mandate budget.reserveForJudge must be a whole number of at least 0, got: ${r}`
      );
    }
  }
  return m;
}

export function mandateFromArgs(args: Record<string, string | undefined>): Mandate {
  const txs = args.txs ? readDigestList(args.txs) : undefined;
  const target = args.target ?? (txs ? `explicit:${txs.length} tx(s)` : "");
  const checkpoints = optionalPositiveInt(args.checkpoints, DEFAULT_MANDATE.checkpoints, "--checkpoints");
  const goal = args.goal ?? DEFAULT_MANDATE.goal;

  const budget = {
    maxRpcCalls: optionalPositiveInt(args.budgetRpc, DEFAULT_BUDGET.maxRpcCalls, "--budget-rpc"),
    maxLlmCalls: optionalPositiveInt(args.budgetLlm, DEFAULT_BUDGET.maxLlmCalls, "--budget-llm"),
    maxLlmTokens: optionalPositiveInt(
      args.budgetTokens,
      DEFAULT_BUDGET.maxLlmTokens,
      "--budget-tokens"
    ),
    maxWallMs: args.budgetMinutes
      ? optionalPositiveInt(args.budgetMinutes, 1, "--budget-minutes") * 60 * 1000
      : DEFAULT_BUDGET.maxWallMs,
    reserveForJudge: optionalNonNegativeInt(args.reserveJudge, "--reserve-judge"),
  };

  return validateMandate({ target, checkpoints, goal, budget, txs });
}
