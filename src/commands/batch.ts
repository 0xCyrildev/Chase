import fs from "node:fs";
import { runAnalysis } from "./analyze.js";
import { toJson } from "../lib/reporter.js";
import { AnalysisReport } from "../lib/types.js";

interface BatchOptions {
  out?: string;
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

  console.error(`[chase] batch analyzing ${digests.length} digest(s)...`);

  const results: (AnalysisReport | { digest: string; error: string })[] = [];
  for (const digest of digests) {
    try {
      const report = await runAnalysis(digest, false);
      const flag = report.violations.length > 0 ? `⚠ ${report.violations.length}` : "✓";
      console.error(`[chase] ${flag} ${digest.slice(0, 16)}…`);
      results.push(report);
    } catch (err: any) {
      const msg = err?.reason === "notFound"
        ? "not found (pruned or wrong network)"
        : err?.message ?? String(err);
      console.error(`[chase] ✗ ${digest.slice(0, 16)}… ${msg}`);
      results.push({ digest, error: msg });
    }
  }

  const ndjson = results.map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n");

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
  process.exit(totalViolations > 0 ? 1 : 0);
}
