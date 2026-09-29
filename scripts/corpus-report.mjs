// Offline corpus report: runs the whole invariant + triage pipeline over every cached trace, so a
// detector change can be measured rather than argued about. The traces come from the local cache, so
// it costs no RPC and repeats exactly. CHASE_HISTORY_FILE is emptied so no run ages its own corpus
// toward the novelty penalty and tiers cannot drift between two invocations.
//
// Triage scores one finding per violation, so the per-transaction view taken here is the worst tier
// any of its violations reached — that is what a reader of `chase triage` actually sees.
//
//   node scripts/corpus-report.mjs [label]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const NETWORK = process.env.CORPUS_NETWORK ?? "mainnet";
const CACHE = process.env.CORPUS_CACHE_DIR ?? path.join(os.homedir(), ".cache", "chase", NETWORK);
process.env.CHASE_CACHE_DIR = path.dirname(CACHE);
process.env.CHASE_HISTORY_FILE = "";

const TIER_ORDER = ["P0", "P1", "P2", "P3", "NOISE"];

const { triage } = await import("../dist/triage/index.js");

const digests = fs.readdirSync(CACHE).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

const byType = new Map();
const bySeverity = new Map();
const worstTier = new Map();
const tierOfType = new Map();
const flashShapes = new Map();
let skipped = 0;
let findingCount = 0;

for (let i = 0; i < digests.length; i += 500) {
  const chunk = digests.slice(i, i + 500);
  const report = await triage(chunk, { network: NETWORK });
  skipped += (report.skipped ?? []).length;
  for (const f of report.findings) {
    findingCount++;
    const type = f.violation?.type ?? "UNKNOWN";
    const severity = f.violation?.severity ?? "?";
    byType.set(type, (byType.get(type) ?? 0) + 1);
    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1);

    const seen = tierOfType.get(type);
    if (!seen || TIER_ORDER.indexOf(f.tier) < TIER_ORDER.indexOf(seen.tier)) {
      tierOfType.set(type, { tier: f.tier, score: f.score });
    }

    const current = worstTier.get(f.digest);
    if (!current || TIER_ORDER.indexOf(f.tier) < TIER_ORDER.indexOf(current)) {
      worstTier.set(f.digest, f.tier);
    }

    if (type === "FLASH_LOAN_SHAPED") {
      const ev = f.violation?.evidence;
      const names = `${ev?.borrow?.function ?? "?"}/${ev?.repay?.function ?? "?"}`;
      flashShapes.set(names, (flashShapes.get(names) ?? 0) + 1);
    }
  }
}

const analyzed = digests.length - skipped;
const flagged = worstTier.size;
const tierCounts = new Map();
for (const t of worstTier.values()) tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
const sortEntries = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log(`label=${process.argv[2] ?? "-"} network=${NETWORK}`);
console.log(
  `traces=${digests.length} skipped=${skipped} analyzed=${analyzed} txs-with-findings=${flagged} (${((flagged / analyzed) * 100).toFixed(1)}%) findings=${findingCount}`
);
console.log("worst tier per tx: " + TIER_ORDER.filter((t) => tierCounts.get(t)).map((t) => `${t}=${tierCounts.get(t)}`).join(" "));
console.log("severity:      " + sortEntries(bySeverity).map(([k, v]) => `${k}=${v}`).join(" "));
console.log("type:          " + sortEntries(byType).map(([k, v]) => `${k}=${v}`).join(" "));
console.log(
  "worst tier by type: " +
    [...tierOfType.entries()].map(([t, v]) => `${t}→${v.tier}(${v.score})`).join(" ")
);
console.log("flash shapes:  " + sortEntries(flashShapes).map(([k, v]) => `${k}=${v}`).join(", "));
