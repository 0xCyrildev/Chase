import { runAnalysis, Network, resolveNetwork } from "../commands/analyze.js";
import { NonProgrammableTransaction } from "../lib/fetcher.js";
import { AnalysisReport } from "../lib/types.js";
import { enrich } from "./enrich.js";
import { scoreFinding } from "./scoring.js";
import { explainBatch } from "./explain.js";
import { formatReport } from "./report.js";
import { recordFindings } from "./history.js";
import { SkippedDigest, TriagedFinding, TriageReport, Tier } from "./types.js";

export interface TriageOptions {
  network?: Network;
  explain?: boolean;
  minTier?: Tier;
  /** Opt-in. Off by default so the MCP tool and the scout stay read-only. */
  record?: boolean;
}

const TIER_ORDER: Tier[] = ["P0", "P1", "P2", "P3", "NOISE"];

export async function triage(
  digests: string[],
  opts: TriageOptions = {}
): Promise<TriageReport> {
  const network = resolveNetwork(opts.network);
  const findings: TriagedFinding[] = [];
  const skipped: SkippedDigest[] = [];

  for (const digest of digests) {
    // A batch file is the documented input, and batch files contain digests that no longer resolve.
    // One of those must not cost the caller every finding already collected.
    let report: AnalysisReport;
    try {
      report = await runAnalysis(digest, false, true, network);
    } catch (err) {
      skipped.push({ digest, network, reason: describeFailure(err) });
      continue;
    }

    const enriched = await enrich(report);
    const scored = enriched.map(scoreFinding);

    const explained =
      opts.explain === true ? await explainBatch(scored) : scored;

    findings.push(...explained);
  }

  const filtered =
    opts.minTier !== undefined
      ? findings.filter(
          (f) => TIER_ORDER.indexOf(f.tier) <= TIER_ORDER.indexOf(opts.minTier!)
        )
      : findings;

  if (opts.record === true) recordFindings(filtered);

  return formatReport(filtered, digests, skipped);
}

function describeFailure(err: unknown): string {
  const e = err as any;
  if (e?.reason === "notFound") return "not found (pruned or wrong network)";
  if (e instanceof NonProgrammableTransaction) return e.message;
  const first = String(e?.message ?? e).split("\n")[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
