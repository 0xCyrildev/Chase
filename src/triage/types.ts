import { Violation, Severity, AnalysisReport } from "../lib/types.js";

export type Tier = "P0" | "P1" | "P2" | "P3" | "NOISE";
export type NextAction = "DISMISS" | "MANUAL_REVIEW" | "ESCALATE" | "REPRODUCE";

export interface BenignMatch {
  kind: "exact" | "heuristic";
  pattern: string;
  reason: string;
}

export interface EnrichedViolation {
  digest: string;
  network: string;
  sender: string;
  violation: Violation;
  corroborating: Violation[];
  benignMatch?: BenignMatch;
  historyCount: number;
  txSuccess: boolean;
  txStats: AnalysisReport["stats"];
}

export interface TriagedFinding extends EnrichedViolation {
  score: number;
  tier: Tier;
  rationale: string;
  explanation?: string;
  nextAction?: NextAction;
  confidence?: "low" | "medium" | "high";
}

export interface TriageReport {
  generatedAt: string;
  digests: string[];
  summary: {
    total: number;
    byTier: Record<Tier, number>;
    byAction: Record<NextAction, number>;
  };
  findings: TriagedFinding[];
  caveats: string[];
}

export interface TriageConfig {
  severityWeights: Record<Severity, number>;
  corroboration: { perExtraInvariant: number; cap: number };
  benignPenalty: { exactMatch: number; heuristicMatch: number };
  noveltyPenalty: { threshold: number; penalty: number };
  confidenceModifier: Record<string, number>;
  tiers: { P0: number; P1: number; P2: number; P3: number };
}
