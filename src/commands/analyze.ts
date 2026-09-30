import { TraceFetcher, NonProgrammableTransaction } from "../lib/fetcher.js";
import { allInvariants } from "../invariants/index.js";
import { objectChangesWithNoEventInTx } from "../invariants/silent-object-change.js";
import { printReport, toJson } from "../lib/reporter.js";
import { AnalysisReport, Violation } from "../lib/types.js";
import fs from "node:fs";

export type Network = "mainnet" | "testnet" | "devnet";

export interface AnalyzeOptions {
  json?: boolean;
  out?: string;
  debug?: boolean;
  cache?: boolean;
  network?: Network;
}

function shortType(t: string): string {
  const idx = t.indexOf("::");
  if (idx === -1) return t;
  const rest = t.slice(idx + 2);
  return rest.length > 60 ? rest.slice(0, 60) + "…" : rest;
}

const NETWORKS: Network[] = ["mainnet", "testnet", "devnet"];

/** Explicit flag wins, then $SUI_NETWORK, then mainnet. Junk is rejected rather than guessed. */
export function resolveNetwork(explicit?: Network): Network {
  const chosen = explicit ?? (process.env.SUI_NETWORK as Network | undefined) ?? "mainnet";
  if (!NETWORKS.includes(chosen)) {
    throw new Error(`unknown network "${chosen}" (expected one of: ${NETWORKS.join(", ")})`);
  }
  return chosen;
}

export async function analyzeCommand(digest: string, opts: AnalyzeOptions) {
  const network = resolveNetwork(opts.network);

  let report: AnalysisReport;
  try {
    report = await runAnalysis(digest, opts.debug ?? false, opts.cache !== false, network);
  } catch (err) {
    if (err instanceof NonProgrammableTransaction) {
      const skipped = { digest, network, skipped: true, reason: err.message };
      console.log(opts.json ? JSON.stringify(skipped, null, 2) : `[chase] ${err.message}`);
      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(skipped, null, 2));
        console.error(`[chase] report written to ${opts.out}`);
      }
      process.exit(0);
    }
    throw err;
  }

  if (opts.json) {
    console.log(toJson(report));
  } else {
    printReport(report);
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, toJson(report));
    console.error(`[chase] report written to ${opts.out}`);
  }

  process.exit(report.violations.length > 0 ? 1 : report.detectorErrors.length > 0 ? 2 : 0);
}

export async function runAnalysis(
  digest: string,
  debug = false,
  useCache = true,
  network?: Network
): Promise<AnalysisReport> {
  const resolvedNetwork = resolveNetwork(network);

  const fetcher = new TraceFetcher(resolvedNetwork, useCache);

  if (debug) console.error(`[chase] fetching trace for ${digest}...`);
  const trace = await fetcher.fetch(digest);

  if (!trace.success) {
    console.error(
      `[chase] note: transaction ${digest} failed on-chain — analyzing attempted calls anyway`
    );
  }

  if (debug) {
    console.error("[chase.debug] resolved commands:");
    for (const cmd of trace.ptbCommands) {
      const call = cmd.packageId
        ? ` ${cmd.packageId.slice(0, 10)}…::${cmd.module}::${cmd.function}`
        : "";
      const mut = cmd.returnsMutableRef !== undefined ? ` mutable=${cmd.returnsMutableRef}` : "";
      console.error(`  [${cmd.index}] ${cmd.kind}${call}${mut}`);
    }

    console.error("[chase.debug] balance changes:");
    for (const bc of trace.balanceChanges) {
      console.error(`  ${bc.owner} ${bc.coinType.slice(0, 40)}… ${bc.amount}`);
    }

    console.error(`[chase.debug] events (${trace.events.length}):`);
    for (const ev of trace.events) {
      const short = ev.type.split("::").pop() ?? ev.type;
      console.error(`  ${ev.packageId.slice(0, 10)}…::${ev.module}::${short}`);
    }

    console.error(`[chase.debug] object changes (${trace.objectChanges.length}):`);
    for (const oc of trace.objectChanges) {
      console.error(`  ${oc.changeType} ${oc.objectId.slice(0, 20)}… ${shortType(oc.objectType)}`);
    }
  }

  const violations: Violation[] = [];
  const detectorErrors: string[] = [];
  for (const inv of allInvariants) {
    try {
      const found = inv.check(trace);
      if (found.length > 0 && debug) {
        console.error(`[chase] ${inv.name}: ${found.length} violation(s)`);
      }
      violations.push(...found);
    } catch (err: any) {
      const detail = `${inv.name}: ${String(err?.message ?? err).slice(0, 200)}`;
      detectorErrors.push(detail);
      console.error(`[chase] invariant ${detail}`);
    }
  }

  return {
    digest,
    // The trace records where it actually came from, which is the only honest provenance
    // when a cached trace was fetched on another network.
    network: trace.network ?? resolvedNetwork,
    timestamp: new Date().toISOString(),
    sender: trace.sender,
    success: trace.success,
    violations,
    detectorErrors,
    stats: {
      balanceChanges: trace.balanceChanges.length,
      objectChanges: trace.objectChanges.length,
      ptbCommands: trace.ptbCommands.length,
      events: trace.events.length,
      silentObjectChanges: objectChangesWithNoEventInTx(trace),
    },
  };
}
