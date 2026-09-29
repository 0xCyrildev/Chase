import { Budget, BudgetExceeded } from "./budget.js";
import { Mandate, ScanResult, ScoutDecision, AgentReport, ScanCoverage } from "./types.js";
import {
  TraceFetcher,
  NonProgrammableTransaction,
  ListedTransaction,
  ListedTransactions,
} from "../lib/fetcher.js";
import { runAnalysis } from "../commands/analyze.js";
import { triage } from "../triage/index.js";
import { investigate, InvestigationResult } from "./investigator.js";

export interface ScoutOptions {
  dryRun?: boolean;
  network?: "mainnet" | "testnet" | "devnet";
  triage?: boolean;
  verbose?: boolean;
  maxIterations?: number;
}

export interface ScoutDecisionInput {
  mandate: Mandate;
  iteration: number;
  previousFindings: ScanResult[];
  currentFilter: string;
  coverage: ScanCoverage;
  remaining: { rpc: number; llm: number; tokens: number; ms: number };
}

/**
 * A summary that could not be produced is reported as such instead of being passed off as the
 * scout's own conclusion.
 */
export interface SummaryOutcome {
  text: string;
  tokens: number;
  degraded?: boolean;
}

export interface ScoutLLM {
  decide(input: ScoutDecisionInput): Promise<ScoutDecision>;
  summarize(input: ScoutSummaryInput): Promise<SummaryOutcome>;
}

export interface ScoutSummaryInput {
  mandate: Mandate;
  findings: ScanResult[];
  decisions: ScoutDecision[];
  coverage: ScanCoverage;
  usage: { rpcCalls: number; llmCalls: number; llmTokens: number; elapsedMs: number };
}

export interface TriagedScanResult extends ScanResult {
  tier?: string;
  action?: string;
  score?: number;
  investigation?: InvestigationResult;
  /** Set when triage produced no verdict, so an absent tier is never read as a clean result. */
  tierError?: string;
  investigationError?: string;
}

export async function scout(
  mandate: Mandate,
  llm: ScoutLLM,
  opts: ScoutOptions = {}
): Promise<AgentReport> {
  const budget = new Budget(mandate.budget);
  const network = opts.network ?? "mainnet";
  const verbose = opts.verbose ?? false;
  const startedAt = new Date().toISOString();
  const findings: TriagedScanResult[] = [];
  const decisions: ScoutDecision[] = [];

  const coverage: ScanCoverage = {
    passes: 0,
    startCheckpoint: null,
    endCheckpoint: null,
    checkpointsScanned: 0,
    txsListed: 0,
    txsAnalyzed: 0,
    txsSkipped: 0,
    txsCarried: 0,
    txsErrored: 0,
    complete: true,
    analysisComplete: true,
    controlTraffic: null,
  };
  let seqMin: bigint | null = null;
  let seqMax: bigint | null = null;

  let currentFilter = mandate.target;
  let iteration = 0;
  const maxIterations = Math.max(1, opts.maxIterations ?? 10);
  const seen = new Set<string>();
  let lastPassFindings: ScanResult[] = [];

  while (iteration < maxIterations) {
    iteration++;

    if (budget.remaining().rpc <= 0) {
      decisions.push({ action: "stop", reason: "rpc budget exhausted", degraded: true });
      break;
    }

    if (opts.dryRun) {
      console.error(`[scout] dry-run iteration ${iteration}, filter=${currentFilter}`);
      const decision = await askLlm(llm, budget, {
        mandate,
        iteration,
        previousFindings: lastPassFindings,
        currentFilter,
        coverage,
        remaining: budget.remaining(),
      });
      decisions.push(decision);

      if (decision.action === "stop") break;
      if (decision.newFilter) currentFilter = decision.newFilter;
      lastPassFindings = [];
      continue;
    }

    const pass = await runScanPass(currentFilter, mandate, budget, network, verbose, seen);
    findings.push(...pass.results);
    lastPassFindings = pass.results;

    coverage.passes++;
    coverage.checkpointsScanned += pass.checkpoints;
    coverage.txsListed += pass.transactions.length;
    coverage.txsAnalyzed += pass.txsAnalyzed;
    coverage.txsSkipped += pass.txsSkipped;
    coverage.txsCarried += pass.txsCarried;
    coverage.txsErrored += pass.txsErrored;
    coverage.complete = coverage.complete && pass.complete;
    coverage.analysisComplete =
      coverage.analysisComplete &&
      pass.txsAnalyzed + pass.txsSkipped + pass.txsCarried + pass.txsErrored ===
        pass.transactions.length;
    coverage.controlTraffic = coverage.controlTraffic ?? pass.controlTraffic;
    if (pass.readRange) {
      seqMin =
        seqMin === null || seqMin > pass.startCheckpoint
          ? pass.startCheckpoint
          : seqMin;
      seqMax =
        seqMax === null || seqMax < pass.endCheckpoint
          ? pass.endCheckpoint
          : seqMax;
    }

    if (verbose) {
      console.error(
        `[scout] iteration ${iteration}: ${pass.results.length} findings from ${pass.txsAnalyzed}/${pass.transactions.length} txs${
          pass.readRange ? ` over seq ${pass.startCheckpoint}..${pass.endCheckpoint}` : " (range unread)"
        }${pass.complete ? "" : " (TRUNCATED)"}`
      );
    }

    if (budget.nearLimit()) {
      decisions.push({
        action: "stop",
        reason: "approaching budget limit",
      });
      break;
    }

    const decision = await askLlm(llm, budget, {
      mandate,
      iteration,
      previousFindings: lastPassFindings,
      currentFilter,
      coverage,
      remaining: budget.remaining(),
    });

    decisions.push(decision);

    if (decision.action === "stop") break;
    if (decision.newFilter) currentFilter = decision.newFilter;
  }

  if (opts.triage !== false && findings.length > 0) {
    await triageFindings(findings, network, budget);
    await investigateFindings(findings, network, budget);
  }

  coverage.startCheckpoint = seqMin === null ? null : seqMin.toString();
  coverage.endCheckpoint = seqMax === null ? null : seqMax.toString();

  let summary: SummaryOutcome;
  try {
    summary = await llm.summarize({
      mandate,
      findings,
      decisions,
      coverage,
      usage: budget.usage(),
    });
  } catch (err: any) {
    summary = {
      text: `summary unavailable: ${String(err?.message ?? err).slice(0, 200)}`,
      tokens: 0,
      degraded: true,
    };
  }
  chargeLlm(budget, summary.tokens);

  return {
    mandate,
    startedAt,
    finishedAt: new Date().toISOString(),
    usage: budget.usage(),
    findings,
    decisions,
    coverage,
    summary: summary.text,
    summaryDegraded: summary.degraded ?? false,
  };
}

/**
 * Providers that omit usage fall back to a fixed estimate per call, so the token ceiling still
 * bounds the run; the estimate is documented rather than presented as a measured figure.
 */
const DEFAULT_TOKEN_ESTIMATE = 500;

function chargeLlm(budget: Budget, tokens: number | undefined): void {
  const charged = tokens && tokens > 0 ? tokens : DEFAULT_TOKEN_ESTIMATE;
  try {
    budget.spendLlm(charged);
  } catch (err) {
    // Running out of LLM budget ends the run via remaining()/nearLimit(), it must not
    // discard the report that the scan already produced.
    if (!(err instanceof BudgetExceeded)) throw err;
  }
}

async function askLlm(
  llm: ScoutLLM,
  budget: Budget,
  input: ScoutDecisionInput
): Promise<ScoutDecision> {
  let decision: ScoutDecision;
  try {
    decision = await llm.decide(input);
  } catch (err: any) {
    return {
      action: "stop",
      reason: `decision backend threw: ${String(err?.message ?? err).slice(0, 200)}`,
      degraded: true,
    };
  }

  chargeLlm(budget, decision.tokens);
  return decision;
}

async function triageFindings(
  findings: TriagedScanResult[],
  network: "mainnet" | "testnet" | "devnet",
  budget: Budget
): Promise<void> {
  for (const finding of findings) {
    if (budget.remaining().rpc < 2) break;

    try {
      // NOISE must be included, otherwise a deliberately dismissed finding is
      // indistinguishable from triage having failed.
      const report = await triage([finding.digest], { network, minTier: "NOISE" });
      budget.spendRpc();
      const top = report.findings[0];
      if (top) {
        finding.tier = top.tier;
        finding.action = top.nextAction;
        finding.score = top.score;
      } else {
        finding.tierError = "triage returned no findings for this digest";
      }
    } catch (err: any) {
      finding.tierError = `triage failed: ${String(err?.message ?? err).slice(0, 200)}`;
    }
  }
}

async function investigateFindings(
  findings: TriagedScanResult[],
  network: "mainnet" | "testnet" | "devnet",
  budget: Budget
): Promise<void> {
  for (const finding of findings) {
    if (finding.tier !== "P0" && finding.tier !== "P1" && finding.tier !== "P2") continue;
    if (budget.remaining().rpc < 4) break;

    try {
      finding.investigation = await investigate(finding, network);
      budget.spendRpc(3);
    } catch (err: any) {
      finding.investigationError = `investigation failed: ${String(err?.message ?? err).slice(0, 200)}`;
    }
  }
}

interface PassResult {
  results: ScanResult[];
  transactions: ListedTransaction[];
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  checkpoints: number;
  /** False when the range could not be read at all, so it must not count as covered. */
  readRange: boolean;
  txsAnalyzed: number;
  txsSkipped: number;
  txsCarried: number;
  txsErrored: number;
  complete: boolean;
  controlTraffic: ScanCoverage["controlTraffic"];
}

async function runScanPass(
  filter: string,
  mandate: Mandate,
  budget: Budget,
  network: "mainnet" | "testnet" | "devnet",
  verbose: boolean,
  seen: Set<string>
): Promise<PassResult> {
  const fetcher = new TraceFetcher(network, true);

  let current: bigint;
  try {
    ({ current } = await fetcher.getCheckpointHeight());
    budget.spendRpc();
  } catch (err: any) {
    const code = err?.code ? `[${err.code}] ` : "";
    console.error(
      `[scout] checkpoint height lookup failed: ${code}${err?.message || err?.name || "unknown error"}`
    );
    return {
      results: [],
      transactions: [],
      startCheckpoint: 0n,
      endCheckpoint: 0n,
      checkpoints: 0,
      readRange: false,
      txsAnalyzed: 0,
      txsSkipped: 0,
      txsCarried: 0,
      txsErrored: 0,
      complete: false,
      controlTraffic: null,
    };
  }

  const endCheckpoint = current - 2n;
  const startCheckpoint = endCheckpoint - (BigInt(mandate.checkpoints) - 1n);
  const isPackageId = /^0x[0-9a-f]{64}$/i.test(filter);

  if (verbose) {
    console.error(
      `[scout] listing seq ${startCheckpoint}..${endCheckpoint} (${
        isPackageId ? "server-side filter: MoveCalls into target" : "no filter: all transactions"
      })`
    );
  }

  let listed: ListedTransactions;
  try {
    listed = await fetcher.listTransactions({
      startCheckpoint,
      endCheckpoint,
      moveCallFunction: isPackageId ? filter : undefined,
    });
    budget.spendRpc();
  } catch (err: any) {
    const code = err?.code ? `[${err.code}] ` : "";
    console.error(
      `[scout] transaction listing failed: ${code}${err?.message || err?.name || "unknown error"}`
    );
    return {
      results: [],
      transactions: [],
      startCheckpoint,
      endCheckpoint,
      checkpoints: 0,
      readRange: false,
      txsAnalyzed: 0,
      txsSkipped: 0,
      txsCarried: 0,
      txsErrored: 0,
      complete: false,
      controlTraffic: null,
    };
  }

  // An empty filtered listing is not a clean scan. Ask whether the same range holds any
  // transaction at all, so "target not called" stays distinguishable from "range unreadable".
  let controlTraffic: ScanCoverage["controlTraffic"] = null;
  if (listed.transactions.length === 0 && isPackageId) {
    try {
      const control = await fetcher.listTransactions({
        startCheckpoint,
        endCheckpoint,
        limit: 1,
      });
      budget.spendRpc();
      controlTraffic = control.transactions.length > 0 ? "traffic-in-range" : "no-traffic-in-range";
      if (verbose) {
        console.error(`[scout] control: ${controlTraffic}`);
      }
    } catch (err: any) {
      const code = err?.code ? `[${err.code}] ` : "";
      console.error(
        `[scout] control listing failed: ${code}${err?.message || err?.name || "unknown error"}`
      );
    }
  }

  const results: ScanResult[] = [];
  let txsAnalyzed = 0;
  let txsSkipped = 0;
  let txsCarried = 0;
  let txsErrored = 0;
  let stoppedEarly = false;

  // The work is already paid for by the time the charge happens, so running out of budget
  // here must end the pass rather than discard the whole report.
  const chargeOrStop = (): boolean => {
    try {
      budget.spendRpc();
      return true;
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        stoppedEarly = true;
        return false;
      }
      throw err;
    }
  };

  for (const tx of listed.transactions) {
    if (budget.remaining().rpc <= 1) {
      if (verbose) {
        console.error(`[scout] stopping pass: only ${budget.remaining().rpc} rpc calls left`);
      }
      break;
    }

    if (seen.has(tx.digest)) {
      txsCarried++;
      continue;
    }
    seen.add(tx.digest);

    try {
      const report = await runAnalysis(tx.digest, false, true, network);
      txsAnalyzed++;
      if (!chargeOrStop()) break;

      // A package id is already scoped by the server-side filter. A free-text target can
      // only be matched after analysis, against the violation evidence.
      if (!isPackageId) {
        const touchesTarget = report.violations.some((v) =>
          JSON.stringify(v.evidence ?? {}).includes(filter)
        );
        if (!touchesTarget) continue;
      }

      if (report.violations.length > 0) {
        results.push({
          checkpoint: tx.checkpoint?.toString() ?? endCheckpoint.toString(),
          digest: tx.digest,
          violations: report.violations.map((v) => ({
            type: v.type,
            severity: v.severity,
            message: v.message,
          })),
        });
      }
    } catch (err: any) {
      if (err instanceof BudgetExceeded) {
        stoppedEarly = true;
        break;
      }

      chargeOrStop();

      if (err instanceof NonProgrammableTransaction) {
        txsSkipped++;
        continue;
      }

      txsErrored++;
      console.error(
        `[scout] ${tx.digest.slice(0, 14)}… analysis failed: ${err?.message || err?.name || "unknown error"}`
      );
    }
  }

  if (verbose) {
    const parts = [`${txsAnalyzed} analyzed`, `${txsSkipped} system txs skipped`];
    if (txsCarried > 0) parts.push(`${txsCarried} already seen`);
    if (txsErrored > 0) parts.push(`${txsErrored} FAILED`);
    if (stoppedEarly) parts.push("cut short by budget");
    console.error(
      `[scout] pass over ${listed.transactions.length} listed txs: ${parts.join(", ")}`
    );
  }

  return {
    results,
    transactions: listed.transactions,
    startCheckpoint: listed.startCheckpoint,
    endCheckpoint: listed.endCheckpoint,
    checkpoints: listed.checkpoints,
    readRange: true,
    txsAnalyzed,
    txsSkipped,
    txsCarried,
    txsErrored,
    complete: listed.complete,
    controlTraffic,
  };
}
