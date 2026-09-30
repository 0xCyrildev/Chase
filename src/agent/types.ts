export interface Mandate {
  target: string;
  checkpoints: number;
  goal: string;
  /**
   * Analyze exactly these transactions instead of sweeping checkpoints. One pass, no listing, no
   * sampling — the difference between "I watched a window and saw nothing" and "I looked at the
   * digest you actually care about", and the only supported way to drive the escalation path on a
   * known transaction.
   */
  txs?: string[];
  budget: {
    maxRpcCalls: number;
    maxLlmCalls: number;
    maxLlmTokens: number;
    maxWallMs: number;
    /** RPC calls the scan phase may not spend, kept for triage and escalation. */
    reserveForJudge?: number;
  };
}

export interface ScanCoverage {
  /**
   * Which chain this scan read. A `--txs` list spanning two networks is analysed entirely on the
   * mandate's single network, and every digest from the other one fails as `not found`, which looks
   * like retention and is not. Coverage that cannot say which chain it looked at cannot explain
   * its own failures.
   */
  network?: "mainnet" | "testnet" | "devnet";
  passes: number;
  startCheckpoint: string | null;
  endCheckpoint: string | null;
  checkpointsScanned: number;
  txsListed: number;
  txsAnalyzed: number;
  /** System transactions with no programmable body — a legitimate skip. */
  txsSkipped: number;
  /**
   * Transactions whose resolved MoveCalls did not touch the target package. Reached and
   * answered, just not a match — without this the coverage arithmetic reads them as unreached.
   */
  txsTargetMissed: number;
  /** Already analyzed in an earlier pass; passes overlap as the chain advances. */
  txsCarried: number;
  /** Analyses that failed for a reason other than being a system transaction. */
  txsErrored: number;
  /** Every listing walked to its checkpoint bound. */
  complete: boolean;
  /** Every transaction returned by a listing was accounted for: analyzed, skipped, missed, seen or failed. */
  analysisComplete: boolean;
}

export interface ScanResult {
  checkpoint: string;
  digest: string;
  violations: Array<{
    type: string;
    severity: string;
    message: string;
    /**
     * What the detector keyed off — the commands, modules or coin types behind the message. Kept so
     * an escalated finding can be read against its own evidence instead of only against its tier.
     */
    evidence?: Record<string, unknown>;
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
