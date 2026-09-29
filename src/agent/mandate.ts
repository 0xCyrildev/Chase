import fs from "node:fs";
import { Mandate } from "./types.js";

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
  m.checkpoints = positiveInt(m.checkpoints, "Mandate checkpoints");
  m.budget.maxRpcCalls = positiveInt(m.budget.maxRpcCalls, "Mandate budget.maxRpcCalls");
  m.budget.maxLlmCalls = positiveInt(m.budget.maxLlmCalls, "Mandate budget.maxLlmCalls");
  m.budget.maxLlmTokens = positiveInt(m.budget.maxLlmTokens, "Mandate budget.maxLlmTokens");
  m.budget.maxWallMs = positiveInt(m.budget.maxWallMs, "Mandate budget.maxWallMs");
  return m;
}

export function mandateFromArgs(args: Record<string, string | undefined>): Mandate {
  const target = args.target ?? "";
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
  };

  return validateMandate({ target, checkpoints, goal, budget });
}
