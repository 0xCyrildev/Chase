import fs from "node:fs";
import { runAnalysis, Network } from "./analyze.js";
import { toJson } from "../lib/reporter.js";
import { pMap } from "../lib/concurrency.js";
import { AnalysisReport } from "../lib/types.js";

interface BatchOptions {
  out?: string;
  concurrency?: string;
  network?: Network;
}

export async function batchCommand(file: string, opts: BatchOptions) {
  if (!fs.existsSync(file)) {
    console.error(`[chase] file not found: ${file}`);
    process.exit(2);
  }

  const digests = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (digests.length === 0) {
    console.error("[chase] no digests found in file");
    process.exit(2);
  }

  const requestedConcurrency = parseInt(opts.concurrency ?? "5", 10);
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    console.error(`[chase] --concurrency must be an integer of 1 or more`);
    process.exit(2);
  }
  const concurrency = Math.min(20, requestedConcurrency);
  const network = opts.network ?? "mainnet";
  console.error(
    `[chase] batch analyzing ${digests.length} digest(s) on ${network} with concurrency ${concurrency}...`
  );

  const results = await pMap(
    digests,
    async (digest): Promise<AnalysisReport | { digest: string; error: string }> => {
      try {
        const report = await runAnalysis(digest, false, true, network);
        const flag = report.violations.length > 0 ? `⚠ ${report.violations.length}` : "✓";
        console.error(`[chase] ${flag} ${digest.slice(0, 16)}…`);
        return report;
      } catch (err: any) {
        const msg =
          err?.reason === "notFound"
            ? "not found (pruned or wrong network)"
            : err?.message ?? String(err);
        console.error(`[chase] ✗ ${digest.slice(0, 16)}… ${msg}`);
        return { digest, error: msg };
      }
    },
    concurrency
  );

  const ndjson = results
    .map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
    .join("\n");

  if (opts.out) {
    fs.writeFileSync(opts.out, ndjson);
    console.error(`[chase] wrote ${results.length} results to ${opts.out}`);
  } else {
    console.log(ndjson);
  }

  const totalViolations = results.reduce(
    (n, r) => n + ("violations" in r ? r.violations.length : 0),
    0
  );
  const failed = results.filter((r) => "error" in r).length;
  const incompleteDetectors = results.reduce(
    (n, r) => n + ("detectorErrors" in r ? r.detectorErrors.length : 0),
    0
  );

  console.error(
    `[chase] batch: ${results.length - failed}/${results.length} analysed, ` +
      `${totalViolations} violation(s), ${incompleteDetectors} detector error(s)`
  );

  if (failed === results.length) {
    console.error("[chase] every digest failed to analyse; this run proved nothing");
    process.exit(2);
  }

  process.exit(totalViolations > 0 ? 1 : failed > 0 || incompleteDetectors > 0 ? 2 : 0);
}
