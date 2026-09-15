#!/usr/bin/env node
import "../lib/undici-setup.js";
import { printBanner } from "../lib/banner.js";
import { Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import { triage } from "./index.js";
import { printReport, toJson } from "./report.js";
import { Tier } from "./types.js";
import { Network } from "../commands/analyze.js";

dotenv.config({ quiet: true });

const program = new Command();

program
  .name("chase-triage")
  .description("Triage agent for Chase findings")
  .version("0.1.0");

program
  .argument("[input]", "A digest, or a path to a .ndjson batch file")
  .option("--json", "Output as JSON")
  .option("-o, --out <file>", "Write report to file")
  .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet)", "mainnet")
  .option("--explain", "Use the LLM explanation layer (requires ANTHROPIC_API_KEY)")
  .option("--min-tier <tier>", "Filter to this tier and above (P0, P1, P2, P3)")
  .action(async (input, opts) => {
if (!opts.json) printBanner();    
try {
      const digests = resolveInput(input);
      if (digests.length === 0) {
        console.error("[chase-triage] no digests provided");
        process.exit(2);
      }

      const report = await triage(digests, {
        network: opts.network as Network,
        explain: opts.explain,
        minTier: opts.minTier as Tier | undefined,
      });

      if (opts.json) {
        console.log(toJson(report));
      } else {
        printReport(report);
      }

      if (opts.out) {
        fs.writeFileSync(opts.out, toJson(report));
        console.error(`[chase-triage] report written to ${opts.out}`);
      }

      const escalating = report.summary.byTier.P0 + report.summary.byTier.P1;
      process.exit(escalating > 0 ? 1 : 0);
    } catch (err) {
      console.error("[chase-triage] error:", err);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);

function resolveInput(input: string | undefined): string[] {
  if (!input) return [];

  // NDJSON file path
  if (input.endsWith(".ndjson") || fs.existsSync(input)) {
    const lines = fs.readFileSync(input, "utf8").split("\n").filter(Boolean);
    const digests: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.digest === "string") digests.push(obj.digest);
      } catch {
        // Not JSON — assume it's a raw digest
        digests.push(line.trim());
      }
    }
    return digests;
  }

  // Single digest
  return [input];
}
