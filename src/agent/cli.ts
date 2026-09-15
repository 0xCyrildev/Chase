#!/usr/bin/env node
import "../lib/undici-setup.js";
import { Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import { mandateFromArgs } from "./mandate.js";
import { scout } from "./scout.js";
import { RealLLM } from "./llm.js";
import { StubLLM } from "./stub-llm.js";
import { BudgetExceeded } from "./budget.js";

dotenv.config({ quiet: true });

const program = new Command();

program
  .name("chase-hunt")
  .description("Agentic scanner for Sui Move transactions")
  .version("2.0.0");

program
  .option("--target <target>", "Package ID or name to monitor")
  .option("--window <seconds>", "Lookback window in seconds", "600")
  .option("--goal <goal>", "What the scout is looking for", "detect suspicious activity")
  .option("--budget-rpc <n>", "Max RPC calls", "200")
  .option("--budget-llm <n>", "Max LLM calls", "10")
  .option("--budget-tokens <n>", "Max LLM tokens", "50000")
  .option("--budget-minutes <n>", "Max wall clock in minutes", "15")
  .option("--dry-run", "Log decisions without executing scans")
  .option("--real-llm", "Use the real LLM for decisions and summaries")
  .option("--json", "Output report as JSON")
  .option("-o, --out <file>", "Write report to file")
  .option("-n, --network <net>", "Sui network", "mainnet")
  .action(async (opts) => {
    try {
      const mandate = mandateFromArgs(opts);
      const llm = opts.realLlm ? new RealLLM() : new StubLLM();

      const report = await scout(mandate, llm, {
        dryRun: opts.dryRun,
        network: opts.network,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("\nCHASE HUNT REPORT");
        console.log("=================\n");
        console.log(`Target:   ${report.mandate.target}`);
        console.log(`Goal:     ${report.mandate.goal}`);
        console.log(`Started:  ${report.startedAt}`);
        console.log(`Finished: ${report.finishedAt}`);
        console.log(
          `Usage:    ${report.usage.rpcCalls} RPC | ${report.usage.llmCalls} LLM | ${report.usage.llmTokens} tokens | ${report.usage.elapsedMs}ms`
        );
        console.log();
        console.log("Decisions:");
        for (const d of report.decisions) {
          console.log(`  ${d.action}: ${d.reason}`);
        }
        console.log();
        console.log(`Findings: ${report.findings.length}`);
        console.log();
        console.log("Summary:");
        console.log(report.summary);
      }

      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
        console.error(`\nreport written to ${opts.out}`);
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        console.error(`[chase-hunt] budget exhausted: ${err.message}`);
        process.exit(3);
      }
      console.error("[chase-hunt] error:", err);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
