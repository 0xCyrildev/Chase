import { Command } from "commander";
import fs from "node:fs";
import dotenv from "dotenv";
import { printBanner } from "../lib/banner.js";
import { reportError } from "../lib/error.js";
import { triage } from "./index.js";
import { printReport, toJson } from "./report.js";
import { Tier } from "./types.js";
import { Network, resolveNetwork } from "../commands/analyze.js";

dotenv.config({ quiet: true });

/**
 * The triage surface, defined once and mounted two ways: as the `chase-triage` binary
 * (`src/triage/cli.ts`) and as the `chase triage` subcommand (`src/index.ts`). Two copies of an
 * option list drift apart one flag at a time; this file is the reason they cannot.
 */
export function registerTriage(cmd: Command): Command {
  return cmd
    .description("Score, tier and prioritise findings for a digest or an .ndjson batch file")
    .argument("[input]", "A digest, or a path to a .ndjson batch file")
    .option("--json", "Output as JSON")
    .option("-o, --out <file>", "Write report to file")
    .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet); defaults to $SUI_NETWORK, then mainnet")
    .option(
      "--explain",
      "Use the LLM explanation layer (requires LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL)"
    )
    .option("--min-tier <tier>", "Filter to this tier and above (P0, P1, P2, P3)")
    .option(
      "--record",
      "Age these findings into the triage history (off by default; affects future novelty scoring)"
    )
    .action(async (input, opts) => {
      if (!opts.json) printBanner();
      try {
        const digests = resolveInput(input);
        if (digests.length === 0) {
          console.error("[chase-triage] no digests provided");
          process.exit(2);
        }

        const report = await triage(digests, {
          network: resolveNetwork(opts.network as Network | undefined),
          explain: opts.explain,
          minTier: opts.minTier as Tier | undefined,
          record: opts.record,
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
        reportError("[chase-triage] error:", err);
        process.exit(2);
      }
    });
}

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
