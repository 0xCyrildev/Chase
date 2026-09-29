import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Severity } from "../lib/types.js";
import {
  EnrichedViolation,
  TriagedFinding,
  Tier,
  TriageConfig,
  NextAction,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "triage.config.json");

/** Every severity a violation may carry; the config must have a weight for each. */
const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

/**
 * A severity outside the union means a detector emitted something the scoring model has no
 * weight for. Guessing (the old `?? 10`) would silently score an unmodelled severity as if it
 * were `low` and still print a confident tier, so scoring refuses instead.
 */
export class UnknownSeverityError extends Error {
  constructor(
    readonly violationType: string,
    readonly severity: string
  ) {
    super(
      `cannot score ${violationType}: severity "${String(severity)}" has no weight in ` +
        `triage.config.json (known severities: ${SEVERITIES.join(", ")})`
    );
    this.name = "UnknownSeverityError";
  }
}

let configCache: TriageConfig | null = null;

export function loadConfig(): TriageConfig {
  if (configCache) return configCache;
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as TriageConfig;
  assertUsableConfig(config);
  configCache = config;
  return config;
}

function assertUsableConfig(config: TriageConfig): void {
  const weights = config?.severityWeights as unknown as Record<string, unknown> | undefined;
  const missing = SEVERITIES.filter((s) => typeof weights?.[s] !== "number");
  if (missing.length > 0) {
    throw new Error(
      `triage.config.json is missing numeric severityWeights for: ${missing.join(", ")}`
    );
  }
}

function defaultAction(tier: Tier): NextAction {
  switch (tier) {
    case "P0":
      return "ESCALATE";
    case "P1":
    case "P2":
    case "P3":
      return "MANUAL_REVIEW";
    default:
      return "DISMISS";
  }
}

export function scoreFinding(e: EnrichedViolation): TriagedFinding {
  const config = loadConfig();

  const base = severityWeight(config, e.violation.severity, e.violation.type);

  // Agreement, not volume: one bonus per *distinct detector type* that fired alongside this
  // violation. enrich() already collapses to one row per type; the Set here keeps the invariant
  // local to scoring so a caller that builds EnrichedViolation itself cannot reintroduce the
  // row-count escalation (4 ADDRESS_OUTFLOW rows once scored +25 and pushed a P1 to P0).
  const corroboratingTypes = [...new Set(e.corroborating.map((v) => v.type))];
  const corroboration = Math.min(
    corroboratingTypes.length * config.corroboration.perExtraInvariant,
    config.corroboration.cap
  );

  const benignPenalty = e.benignMatch
    ? e.benignMatch.kind === "exact"
      ? config.benignPenalty.exactMatch
      : config.benignPenalty.heuristicMatch
    : 0;

  const noveltyPenalty =
    e.historyCount > config.noveltyPenalty.threshold ? config.noveltyPenalty.penalty : 0;

  const confidenceModifier = config.confidenceModifier[e.violation.type] ?? 0;

  const raw = base + corroboration + benignPenalty + noveltyPenalty + confidenceModifier;
  const score = Math.max(0, Math.min(100, raw));
  const tier = tierFor(score);

  return {
    ...e,
    score,
    tier,
    rationale: buildRationale(e, {
      base,
      corroboration,
      corroboratingTypes,
      benignPenalty,
      noveltyPenalty,
      confidenceModifier,
      score,
    }),
    nextAction: defaultAction(tier),
  };
}

function severityWeight(
  config: TriageConfig,
  severity: Severity,
  violationType: string
): number {
  const weights = config.severityWeights as unknown as Record<string, number | undefined>;
  const weight = weights[severity];
  if (typeof weight !== "number") throw new UnknownSeverityError(violationType, String(severity));
  return weight;
}

function tierFor(score: number): Tier {
  const c = loadConfig();
  if (score >= c.tiers.P0) return "P0";
  if (score >= c.tiers.P1) return "P1";
  if (score >= c.tiers.P2) return "P2";
  if (score >= c.tiers.P3) return "P3";
  return "NOISE";
}

interface Components {
  base: number;
  corroboration: number;
  corroboratingTypes: string[];
  benignPenalty: number;
  noveltyPenalty: number;
  confidenceModifier: number;
  score: number;
}

function buildRationale(e: EnrichedViolation, c: Components): string {
  const parts: string[] = [];
  parts.push(`${e.violation.type} (${e.violation.severity}) base=${c.base}`);
  if (c.corroboration) {
    const n = c.corroboratingTypes.length;
    parts.push(
      `+${c.corroboration} corroboration (${n} independent detector${n === 1 ? "" : "s"}: ${c.corroboratingTypes.join(", ")})`
    );
  }
  if (c.benignPenalty) parts.push(`${c.benignPenalty} benign match: ${e.benignMatch!.pattern}`);
  if (c.noveltyPenalty) parts.push(`${c.noveltyPenalty} seen ${e.historyCount}x before`);
  if (c.confidenceModifier) parts.push(`${c.confidenceModifier >= 0 ? "+" : ""}${c.confidenceModifier} confidence`);
  parts.push(`= ${c.score}`);
  return parts.join(" · ");
}
