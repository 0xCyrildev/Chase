import { Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import { mandateFromArgs, loadMandate } from "./mandate.js";
import { scout } from "./scout.js";
import { RealLLM } from "./llm.js";
import { StubLLM } from "./stub-llm.js";
import { RuleBasedLLM } from "./rules-llm.js";
import { BudgetExceeded } from "./budget.js";
import {
  toMarkdown,
  coverageCaveat,
  coverageSpan,
  investigationProvenance,
  evidenceLine,
} from "./report-md.js";
import { printBanner } from "../lib/banner.js";
import { reportError } from "../lib/error.js";
import { Network, resolveNetwork } from "../commands/analyze.js";

dotenv.config({ quiet: true });

type LlmMode = "real" | "rules" | "stub";

/**
 * The hunt surface, defined once and mounted two ways: as the `chase-hunt` binary
 * (`src/agent/cli.ts`) and as the `chase hunt` subcommand (`src/index.ts`).
 */
export function registerHunt(cmd: Command): Command {
  return cmd
    .description("Agentic scanner: run the budget-bounded scout over a mandate")
    .option("--mandate <file>", "Load a mandate JSON file")
    .option("--target <target>", "Package ID or name to monitor")
    .option(
      "--txs <file>",
      "Analyze exactly the digests listed in this file (one per line, # comments) instead of sweeping checkpoints"
    )
    .option("--checkpoints <n>", "Checkpoints covered per scan pass", "20")
    .option("--goal <goal>", "What the scout is looking for", "detect suspicious activity")
    .option("--budget-rpc <n>", "Max RPC calls", "200")
    .option("--budget-llm <n>", "Max LLM calls", "10")
    .option("--budget-tokens <n>", "Max LLM tokens", "50000")
    .option("--budget-minutes <n>", "Max wall clock in minutes", "15")
    .option(
      "--reserve-judge <n>",
      "RPC calls the scan may not spend, held back for triage and escalation (default: 20% of --budget-rpc, floor 4, capped at half the budget)"
    )
    .option("--dry-run", "Log decisions without executing scans")
    .option("--verbose", "Log scan progress to stderr")
    .option(
      "--mode <mode>",
      "Decision mode: real (LLM), rules (deterministic), stub (fixed responses)",
      "rules"
    )
    .option("--no-triage", "Skip the triage pass on findings")
    .option("--json", "Output report as JSON")
    .option("--md", "Output report as markdown")
    .option("-o, --out <file>", "Write report to file (extension determines format)")
    .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet); defaults to $SUI_NETWORK, then mainnet")
    .action(async (opts) => {
      try {
        const mandate = opts.mandate
          ? loadMandate(opts.mandate)
          : mandateFromArgs(opts);

        if (!mandate.target) {
          console.error("[chase-hunt] --target or --mandate required");
          process.exit(2);
        }

        if (!opts.json && !opts.md) printBanner();

        const llm = buildLlm(opts.mode as LlmMode);

        const report = await scout(mandate, llm, {
          dryRun: opts.dryRun,
          network: resolveNetwork(opts.network as Network | undefined),
          triage: opts.triage !== false,
          verbose: opts.verbose === true,
        });

        const format = pickFormat(opts);

        if (format === "json") {
          console.log(JSON.stringify(report, null, 2));
        } else if (format === "md") {
          console.log(toMarkdown(report));
        } else {
          printHumanReport(report, opts.mode);
        }

        if (opts.out) {
          const content = opts.out.endsWith(".md")
            ? toMarkdown(report)
            : JSON.stringify(report, null, 2);
          fs.writeFileSync(opts.out, content);
          console.error(`report written to ${opts.out}`);
        }
      } catch (err) {
        if (err instanceof BudgetExceeded) {
          console.error(`[chase-hunt] budget exhausted: ${err.message}`);
          process.exit(3);
        }
        reportError("[chase-hunt] error:", err);
        process.exit(2);
      }
    });
}

function buildLlm(mode: LlmMode) {
  switch (mode) {
    case "real":
      return new RealLLM();
    case "rules":
      return new RuleBasedLLM();
    case "stub":
      return new StubLLM();
    default:
      console.error(`[chase-hunt] unknown mode: ${mode}`);
      process.exit(2);
  }
}

function pickFormat(opts: {
  json?: boolean;
  md?: boolean;
  out?: string;
}): "json" | "md" | "human" {
  if (opts.json) return "json";
  if (opts.md) return "md";
  if (opts.out) {
    if (opts.out.endsWith(".md")) return "md";
    if (opts.out.endsWith(".json")) return "json";
  }
  return "human";
}

function printHumanReport(report: any, mode: string): void {
  const c = report.coverage;
  const span = coverageSpan(c);

  console.log("\nCHASE HUNT REPORT");
  console.log("=================\n");
  console.log(`Network:  ${report.coverage?.network ?? "unknown"}`);
  console.log(`Target:   ${report.mandate.target}`);
  console.log(`Goal:     ${report.mandate.goal}`);
  console.log(`Mode:     ${mode}`);
  console.log(
    `Scope:    ${
      report.mandate.txs?.length
        ? `${report.mandate.txs.length} explicit transaction(s), 1 pass (no checkpoint sweep)`
        : `${report.mandate.checkpoints} checkpoints/pass x ${c.passes} passes`
    }`
  );
  console.log(
    `Covered:  seq ${c.startCheckpoint ?? "n/a"}-${c.endCheckpoint ?? "n/a"} (${span ?? 0} wide) | ` +
      `${c.txsListed} listed | ${c.txsAnalyzed} analyzed | ${c.txsTargetMissed} no target call | ` +
      `${c.txsSkipped} system | ${c.txsCarried} repeat`
  );
  console.log(`Coverage: ${coverageCaveat(c)}`);
  console.log(`Started:  ${report.startedAt}`);
  console.log(`Finished: ${report.finishedAt}`);
  console.log(
    `Usage:    ${report.usage.rpcCalls} RPC | ${report.usage.llmCalls} LLM | ${report.usage.llmTokens} tokens | ${report.usage.elapsedMs}ms`
  );
  console.log();
  console.log("Decisions:");
  for (const d of report.decisions) {
    console.log(`  ${d.action}${d.degraded ? " [DEGRADED: not a model decision]" : ""}: ${d.reason}`);
  }
  console.log();
  console.log(`Findings: ${report.findings.length}`);
  if (report.findings.length > 0) {
    for (const f of report.findings) {
      const tier = f.tier ? ` [${f.tier}]` : "";
      const action = f.action ? ` -> ${f.action}` : "";
      console.log(`  ${f.digest}${tier}${action}`);
      if (f.tierError) console.log(`      ! ${f.tierError}`);
      if (f.investigationError) console.log(`      ! ${f.investigationError}`);
      // The verdict was being printed for markdown only, so the escalation most people actually
      // look at was invisible in the terminal.
      if (f.investigation) {
        console.log(
          `      investigator (${f.investigation.verdict}): ${f.investigation.hypothesis}${investigationProvenance(f.investigation)}`
        );
        const evidence = evidenceLine(f.investigation.evidence);
        if (evidence) console.log(`        ${evidence}`);
        if (f.investigation.reasoning) console.log(`        ${f.investigation.reasoning}`);
      }
      for (const v of f.violations ?? []) {
        console.log(`      ${v.severity.toUpperCase()} ${v.type}: ${v.message}`);
      }
    }
  }
  console.log();
  console.log("Summary:");
  if (report.summaryDegraded) console.log("(generated by the fallback, not by the model)");
  console.log(report.summary);
}
