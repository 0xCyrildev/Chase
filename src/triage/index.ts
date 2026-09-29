import { runAnalysis, Network } from "../commands/analyze.js";
import { enrich } from "./enrich.js";
import { scoreFinding } from "./scoring.js";
import { explainBatch } from "./explain.js";
import { formatReport } from "./report.js";
import { recordFindings } from "./history.js";
import { TriagedFinding, TriageReport, Tier } from "./types.js";

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
  const findings: TriagedFinding[] = [];

  for (const digest of digests) {
    const report = await runAnalysis(digest, false, true, opts.network);
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

  return formatReport(filtered, digests);
}
