import { TraceFetcher } from "../lib/fetcher.js";
import { allInvariants } from "../invariants/index.js";
import { printReport, toJson } from "../lib/reporter.js";
import { AnalysisReport, Violation } from "../lib/types.js";
import fs from "node:fs";

interface AnalyzeOptions {
  json?: boolean;
  out?: string;
  debug?: boolean;
}
function shortType(t: string): string {
  const idx = t.indexOf("::");
  if (idx === -1) return t;
  const rest = t.slice(idx + 2);
  return rest.length > 60 ? rest.slice(0, 60) + "…" : rest;
}
export async function analyzeCommand(digest: string, opts: AnalyzeOptions) {
  const network = (process.env.SUI_NETWORK as "mainnet" | "testnet" | "devnet") ?? "mainnet";
  const fetcher = new TraceFetcher(network);

  console.error(`[chase] fetching trace for ${digest}...`);
  const trace = await fetcher.fetch(digest);

  if (opts.debug) {
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
      const shortType = ev.type.split("::").pop() ?? ev.type;
      console.error(`  ${ev.packageId.slice(0, 10)}…::${ev.module}::${shortType}`);
    }

    console.error(`[chase.debug] object changes (${trace.objectChanges.length}):`);
    for (const oc of trace.objectChanges) {
    console.error(`  ${oc.changeType} ${oc.objectId.slice(0, 20)}… ${shortType(oc.objectType)}`);
    }
  }

  const violations: Violation[] = [];
  for (const inv of allInvariants) {
    try {
      const found = inv.check(trace);
      if (found.length > 0) {
        console.error(`[chase] ${inv.name}: ${found.length} violation(s)`);
      }
      violations.push(...found);
    } catch (err) {
      console.error(`[chase] invariant ${inv.name} failed:`, err);
    }
  }

  const report: AnalysisReport = {
    digest,
    network,
    timestamp: new Date().toISOString(),
    sender: trace.sender,
    violations,
    stats: {
      balanceChanges: trace.balanceChanges.length,
      objectChanges: trace.objectChanges.length,
      ptbCommands: trace.ptbCommands.length,
      events: trace.events.length,
    },
  };

  if (opts.json) {
    console.log(toJson(report));
  } else {
    printReport(report);
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, toJson(report));
    console.error(`[chase] report written to ${opts.out}`);
  }

  process.exit(violations.length > 0 ? 1 : 0);
}
