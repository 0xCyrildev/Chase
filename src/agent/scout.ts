import { Budget } from "./budget.js";
import { Mandate, ScanResult, ScoutDecision, AgentReport } from "./types.js";
import { TraceFetcher } from "../lib/fetcher.js";
import { runAnalysis } from "../commands/analyze.js";

export interface ScoutOptions {
  dryRun?: boolean;
  network?: "mainnet" | "testnet" | "devnet";
}

export interface ScoutLLM {
  decide(input: ScoutDecisionInput): Promise<ScoutDecision>;
  summarize(input: ScoutSummaryInput): Promise<string>;
}

export interface ScoutDecisionInput {
  mandate: Mandate;
  iteration: number;
  previousFindings: ScanResult[];
  currentFilter: string;
  remaining: { rpc: number; llm: number; tokens: number; ms: number };
}

export interface ScoutSummaryInput {
  mandate: Mandate;
  findings: ScanResult[];
  decisions: ScoutDecision[];
  usage: { rpcCalls: number; llmCalls: number; llmTokens: number; elapsedMs: number };
}

export async function scout(
  mandate: Mandate,
  llm: ScoutLLM,
  opts: ScoutOptions = {}
): Promise<AgentReport> {
  const budget = new Budget(mandate.budget);
  const network = opts.network ?? "mainnet";
  const startedAt = new Date().toISOString();
  const findings: ScanResult[] = [];
  const decisions: ScoutDecision[] = [];

  let currentFilter = mandate.target;
  let iteration = 0;
  const maxIterations = 10;

  while (iteration < maxIterations) {
    iteration++;
    budget.assertNotExhausted();

    if (opts.dryRun) {
      console.error(`[scout] dry-run iteration ${iteration}, filter=${currentFilter}`);
      const decision: ScoutDecision = {
        action: iteration >= 3 ? "stop" : "continue",
        reason: `dry-run: would scan checkpoints for ${currentFilter} and decide next step`,
      };
      decisions.push(decision);

      if (decision.action === "stop") break;
      continue;
    }

    const scanResults = await runScanPass(currentFilter, mandate, budget, network);
    findings.push(...scanResults);

    if (budget.nearLimit()) {
      decisions.push({
        action: "stop",
        reason: "approaching budget limit",
      });
      break;
    }

    const decision = await llm.decide({
      mandate,
      iteration,
      previousFindings: scanResults,
      currentFilter,
      remaining: budget.remaining(),
    });

    budget.spendLlm(500);
    decisions.push(decision);

    if (decision.action === "stop") break;
    if (decision.newFilter) currentFilter = decision.newFilter;
  }

  const summary = opts.dryRun
    ? "dry-run: no scanning performed"
    : await llm.summarize({
        mandate,
        findings,
        decisions,
        usage: budget.usage(),
      });

  return {
    mandate,
    startedAt,
    finishedAt: new Date().toISOString(),
    usage: budget.usage(),
    findings,
    decisions,
    summary,
  };
}

async function runScanPass(
  filter: string,
  mandate: Mandate,
  budget: Budget,
  network: "mainnet" | "testnet" | "devnet"
): Promise<ScanResult[]> {
  const fetcher = new TraceFetcher(network, true);
  const results: ScanResult[] = [];

  const { current } = await fetcher.getCheckpointHeight();
  budget.spendRpc();

  const checkpointsToScan = Math.min(
    5,
    Math.ceil(mandate.windowSeconds / 3)
  );

  for (let i = 0; i < checkpointsToScan; i++) {
    budget.assertNotExhausted();

    const seq = current - BigInt(i + 2);
    let digests: string[] = [];

    try {
      digests = await fetcher.getCheckpointTransactions(seq);
      budget.spendRpc();
    } catch {
      continue;
    }

    for (const digest of digests) {
      budget.assertNotExhausted();

      try {
        const report = await runAnalysis(digest, false, true, network);
        budget.spendRpc();

        const touchesTarget = report.violations.some((v) =>
          JSON.stringify(v.evidence ?? {}).includes(filter)
        );
        if (!touchesTarget) continue;

        if (report.violations.length > 0) {
          results.push({
            checkpoint: seq.toString(),
            digest,
            violations: report.violations.map((v) => ({
              type: v.type,
              severity: v.severity,
              message: v.message,
            })),
          });
        }
      } catch {
        continue;
      }
    }
  }

  return results;
}
