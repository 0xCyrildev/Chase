export interface Mandate {
  target: string;
  windowSeconds: number;
  goal: string;
  budget: {
    maxRpcCalls: number;
    maxLlmCalls: number;
    maxLlmTokens: number;
    maxWallMs: number;
  };
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
  summary: string;
}
