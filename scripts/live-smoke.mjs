#!/usr/bin/env node
/**
 * Live smoke test against the built artifact: it asks a public fullnode for the current
 * checkpoint, lists one checkpoint behind the tip, and analyzes up to three programmable
 * transactions uncached. The fixture suites prove the invariants; only this proves the
 * transport, the signature resolver and the retention window still answer on a real chain.
 *
 * Deliberately small. A mainnet checkpoint holds hundreds of transactions; this touches three.
 */
import { resolveNetwork } from "../dist/commands/analyze.js";
import { TraceFetcher } from "../dist/lib/fetcher.js";
import { runAnalysis } from "../dist/exports.js";

const MAX_TXS = Number(process.env.CHASE_SMOKE_TXS ?? 3);

let network;
try {
  network = resolveNetwork(process.argv[2]);
} catch (err) {
  console.error(`[smoke] ${err.message}`);
  process.exit(2);
}

const fetcher = new TraceFetcher(network);
const { current, lowest } = await fetcher.getCheckpointHeight();
const seq = current - 2n;
console.log(`[smoke] ${network}: tip=${current} lowest_available=${lowest} probing=${seq}`);

const digests = await fetcher.getCheckpointTransactions(seq);
if (!digests?.length) {
  console.error(`[smoke] FAIL: checkpoint ${seq} listed no transactions`);
  process.exit(1);
}

let analyzed = 0;
let system = 0;
for (const digest of digests) {
  if (analyzed >= MAX_TXS) break;
  try {
    const report = await runAnalysis(digest, false, false, network);
    analyzed++;
    const fired = report.violations.map((v) => v.type).join(",") || "none";
    console.log(
      `[smoke] ${digest.slice(0, 12)}… cmds=${report.stats.ptbCommands} ` +
        `success=${report.success} violations=${report.violations.length} (${fired})`
    );
  } catch (err) {
    if (err?.name === "NonProgrammableTransaction") {
      system++;
      continue;
    }
    console.error(`[smoke] ${digest.slice(0, 12)}… error: ${String(err?.message ?? err).slice(0, 140)}`);
  }
}

if (analyzed === 0) {
  console.error(`[smoke] FAIL: listed ${digests.length} txs, analyzed 0 (${system} system)`);
  process.exit(1);
}

console.log(`[smoke] OK: ${analyzed} live ${network} transaction(s) analyzed, ${system} system txs skipped`);
