export interface Mandate {
  target: string;
  checkpoints: number;
  goal: string;
  budget: {
    maxRpcCalls: number;
    maxLlmCalls: number;
    maxLlmTokens: number;
    maxWallMs: number;
  };
}

export interface ScanCoverage {
  passes: number;
  startCheckpoint: string | null;
  endCheckpoint: string | null;
  checkpointsScanned: number;
  txsListed: number;
  txsAnalyzed: number;
  /** System transactions with no programmable body — a legitimate skip. */
  txsSkipped: number;
  /** Already analyzed in an earlier pass; passes overlap as the chain advances. */
  txsCarried: number;
  /** Analyses that failed for a reason other than being a system transaction. */
  txsErrored: number;
  /** Every listing walked to its checkpoint bound. */
  complete: boolean;
  /** Every transaction returned by a listing was actually analyzed. */
  analysisComplete: boolean;
  /**
   * Existence control, recorded only when a target-filtered listing returned nothing:
   * whether the same range holds any transaction at all. Distinguishes "the target
   * was not called" from "the range was not readable".
   */
  controlTraffic: "traffic-in-range" | "no-traffic-in-range" | null;
}

export interface ScanResult {
  checkpoint: string;
  digest: string;
  violations: Array<{
    type: string;
    severity: string;
    message: string;
  }>;
}

export interface ScoutDecision {
  action: "widen" | "narrow" | "stop" | "continue";
  reason: string;
  newFilter?: string;
  /**
   * Set when the decision did not come from a model: an unconfigured, unreachable or
   * unparseable backend stops the scan, and that must not read as a deliberate stop.
   */
  degraded?: boolean;
  /** Tokens reported by the provider for this call, when the provider reports usage. */
  tokens?: number;
}

export interface AgentReport {
  mandate: Mandate;
  startedAt: string;
  finishedAt: string;
  usage: {
    rpcCalls: number;
    llmCalls: number;
    llmTokens: number;
    elapsedMs: number;
  };
  findings: ScanResult[];
  decisions: ScoutDecision[];
  coverage: ScanCoverage;
  summary: string;
  /** True when the summary came from the fallback text rather than the decision backend. */
  summaryDegraded: boolean;
}
