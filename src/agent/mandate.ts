import fs from "node:fs";
import { Mandate } from "./types.js";

const DEFAULT_MANDATE: Mandate = {
  target: "",
  windowSeconds: 600,
  goal: "detect any suspicious activity",
  budget: {
    maxRpcCalls: 200,
    maxLlmCalls: 10,
    maxLlmTokens: 50000,
    maxWallMs: 15 * 60 * 1000,
  },
};

export function loadMandate(path?: string): Mandate {
  if (!path) return { ...DEFAULT_MANDATE };

  if (!fs.existsSync(path)) {
    throw new Error(`Mandate file not found: ${path}`);
  }

  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return validateMandate({ ...DEFAULT_MANDATE, ...raw });
}

export function validateMandate(m: Mandate): Mandate {
  if (!m.target || typeof m.target !== "string") {
    throw new Error("Mandate requires a target (package ID or name)");
  }
  if (m.windowSeconds <= 0) {
    throw new Error("Mandate windowSeconds must be positive");
  }
  if (m.budget.maxRpcCalls <= 0) {
    throw new Error("Mandate budget.maxRpcCalls must be positive");
  }
  if (m.budget.maxWallMs <= 0) {
    throw new Error("Mandate budget.maxWallMs must be positive");
  }
  return m;
}

export function mandateFromArgs(args: Record<string, string | undefined>): Mandate {
  const target = args.target ?? "";
  const windowSeconds = args.window ? parseInt(args.window, 10) : DEFAULT_MANDATE.windowSeconds;
  const goal = args.goal ?? DEFAULT_MANDATE.goal;

  const budget = {
    maxRpcCalls: args["budget-rpc"] ? parseInt(args["budget-rpc"], 10) : DEFAULT_MANDATE.budget.maxRpcCalls,
    maxLlmCalls: args["budget-llm"] ? parseInt(args["budget-llm"], 10) : DEFAULT_MANDATE.budget.maxLlmCalls,
    maxLlmTokens: args["budget-tokens"] ? parseInt(args["budget-tokens"], 10) : DEFAULT_MANDATE.budget.maxLlmTokens,
    maxWallMs: args["budget-minutes"]
      ? parseInt(args["budget-minutes"], 10) * 60 * 1000
      : DEFAULT_MANDATE.budget.maxWallMs,
  };

  return validateMandate({ target, windowSeconds, goal, budget });
}
