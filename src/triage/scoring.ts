import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnrichedViolation, TriagedFinding, Tier, TriageConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "triage.config.json");

let configCache: TriageConfig | null = null;

export function loadConfig(): TriageConfig {
  if (configCache) return configCache;
  configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return configCache!;
}

export function scoreFinding(e: EnrichedViolation): TriagedFinding {
  const config = loadConfig();

  const base = config.severityWeights[e.violation.severity] ?? 10;

  const corroboration = Math.min(
    e.corroborating.length * config.corroboration.perExtraInvariant,
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

  return {
    ...e,
    score,
    tier: tierFor(score),
    rationale: buildRationale(e, {
      base,
      corroboration,
      benignPenalty,
      noveltyPenalty,
      confidenceModifier,
      score,
    }),
  };
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
  benignPenalty: number;
  noveltyPenalty: number;
  confidenceModifier: number;
  score: number;
}

function buildRationale(e: EnrichedViolation, c: Components): string {
  const parts: string[] = [];
  parts.push(`${e.violation.type} (${e.violation.severity}) base=${c.base}`);
  if (c.corroboration) parts.push(`+${c.corroboration} corroboration (${e.corroborating.length} others)`);
  if (c.benignPenalty) parts.push(`${c.benignPenalty} benign match: ${e.benignMatch!.pattern}`);
  if (c.noveltyPenalty) parts.push(`${c.noveltyPenalty} seen ${e.historyCount}x before`);
  if (c.confidenceModifier) parts.push(`${c.confidenceModifier >= 0 ? "+" : ""}${c.confidenceModifier} confidence`);
  parts.push(`= ${c.score}`);
  return parts.join(" · ");
}
