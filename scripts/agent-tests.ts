#!/usr/bin/env npx tsx
/**
 * Offline regression tests for the paths that only ever had manual evidence: the target matcher that
 * replaced the gRPC moveCall filter, the budget reserve that keeps triage from being starved, the
 * investigator that has never run against live P0 traffic, batch's output shape, and the argument
 * validation that a CLI user sees first.
 *
 * No network. Traces come from the committed fixtures and the history store is disabled, so a failure
 * here means the code changed, not that a fullnode moved.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "test-cases", "fixtures");

process.env.CHASE_CACHE_DIR = FIXTURES;
process.env.CHASE_HISTORY_FILE = "";

const { parseTarget, traceTouchesTarget } = await import("../src/lib/target.js");
const { Budget } = await import("../src/agent/budget.js");
const { investigate } = await import("../src/agent/investigator.js");
const { validateMandate, mandateFromArgs } = await import("../src/agent/mandate.js");

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const PKG = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const ROUTER = "0x3ec740df8428aa9c93aaef7f8cc1542ac3194fd014826b51bfe245346d64efc7";

function trace(over: Record<string, unknown>): any {
  return {
    digest: "x",
    sender: "0x1",
    success: true,
    balanceChanges: [],
    objectChanges: [],
    ptbCommands: [],
    events: [],
    ...over,
  };
}

console.log("\ntarget matching (why the scout was empty)");

// The measured failure: a routed Cetus swap names the router in its top-level call, and the event's
// own packageId is the *updated* package. Only the type strings carry the original id.
const routed = trace({
  ptbCommands: [{ index: 0, kind: "MoveCall", packageId: ROUTER, module: "router", function: "swap" }],
  events: [{ type: `${PKG}::pool::SwapEvent`, packageId: "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943a00000000000000aa" }],
});
const parsedPkg = parseTarget(PKG);
check("routed volume is matched through the event type, not the call", parsedPkg && traceTouchesTarget(routed, parsedPkg.address, parsedPkg.scope));

const parsedRouter = parseTarget(ROUTER);
check("the call package still matches when the target IS the router", parsedRouter && traceTouchesTarget(routed, parsedRouter.address, parsedRouter.scope));

const scopedPool = parseTarget(`${PKG}::pool`);
check("pkg::module scope matches a pool event", scopedPool && traceTouchesTarget(routed, scopedPool.address, scopedPool.scope));

const scopedOther = parseTarget(`${PKG}::keeper`);
check("pkg::module scope does not match an unrelated module", scopedOther && !traceTouchesTarget(routed, scopedOther.address, scopedOther.scope));

const objectShape = trace({
  objectChanges: [{ objectId: "0x2", objectType: `${PKG}::pool::Pool<0x6::sui::SUI>`, changeType: "mutate" }],
});
check("object type prefixes count as presence", parsedPkg && traceTouchesTarget(objectShape, parsedPkg.address, parsedPkg.scope));

const unrelated = trace({
  ptbCommands: [{ index: 0, kind: "MoveCall", packageId: ROUTER, module: "router", function: "swap" }],
  events: [{ type: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::Redeemed", packageId: "0x2" }],
});
check("a transaction that never mentions the target is a miss", parsedPkg && !traceTouchesTarget(unrelated, parsedPkg.address, parsedPkg.scope));

const shortForm = parseTarget("0x2");
const frameworkCall = trace({
  ptbCommands: [{ index: 0, kind: "MoveCall", packageId: "0x0000000000000000000000000000000000000000000000000000000000000002", module: "transfer", function: "transfer" }],
});
check("short addresses normalise before comparison", shortForm && traceTouchesTarget(frameworkCall, shortForm.address, shortForm.scope));

check("free-text targets are not treated as addresses", parseTarget("cetus") === null);
check("malformed addresses are rejected, not guessed", parseTarget("0xzz") === null);
// A 66-hex id is exactly what a hand-typed test constant looks like when it is wrong; it must not be
// silently padded into some other package.
check("over-long addresses are rejected", parseTarget(`0x${"a".repeat(66)}`) === null);

console.log("\nbudget reserve (triage must not be starved)");

const mk = (rpc: number, reserve?: number) =>
  new Budget({ maxRpcCalls: rpc, maxLlmCalls: 5, maxLlmTokens: 5000, maxWallMs: 60000, reserveForJudge: reserve });

check("default reserve is 20% of the budget", mk(100).judgeReserve === 20, String(mk(100).judgeReserve));
check("default reserve has a floor for tiny budgets", mk(5).judgeReserve === 2, String(mk(5).judgeReserve));
check("an explicit 0 means no reserve", mk(100, 0).judgeReserve === 0);
check("a reserve larger than half the budget is capped", mk(100, 90).judgeReserve === 50, String(mk(100, 90).judgeReserve));
check("remainingForScan excludes the reserve", mk(100, 20).remainingForScan() === 80, String(mk(100, 20).remainingForScan()));

const spent = mk(50, 10);
for (let i = 0; i < 45; i++) spent.spendRpc();
check("the scan can spend up to the reserve but not past it", spent.remaining().rpc === 5 && spent.remainingForScan() === 0);

console.log("\nmandate validation");

check("a negative reserve is rejected", (() => {
  try {
    validateMandate({ target: PKG, checkpoints: 5, goal: "g", budget: { maxRpcCalls: 10, maxLlmCalls: 2, maxLlmTokens: 100, maxWallMs: 1000, reserveForJudge: -5 } } as any);
    return false;
  } catch {
    return true;
  }
})());

check("a non-integer reserve is rejected", (() => {
  try {
    validateMandate({ target: PKG, checkpoints: 5, goal: "g", budget: { maxRpcCalls: 10, maxLlmCalls: 2, maxLlmTokens: 100, maxWallMs: 1000, reserveForJudge: 1.5 } } as any);
    return false;
  } catch {
    return true;
  }
})());

check("--reserve-judge abc fails with a message naming the flag", (() => {
  try {
    mandateFromArgs({ target: PKG, reserveJudge: "abc" });
    return false;
  } catch (e: any) {
    return /--reserve-judge/.test(String(e?.message));
  }
})());

check("a mandate without a reserve still validates", (() => {
  const m = validateMandate({ target: PKG, checkpoints: 5, goal: "g", budget: { maxRpcCalls: 10, maxLlmCalls: 2, maxLlmTokens: 100, maxWallMs: 1000 } });
  return m.budget.reserveForJudge === undefined;
})());

console.log("\ninvestigator (escalation branch, offline)");

// P0 fixture: a synthetic public &mut return, published to testnet.
const p0 = await investigate(
  {
    digest: "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg",
    checkpoint: "1",
    violations: [{ type: "MUTABLE_REFERENCE_RETURNED", severity: "high", message: "returns &mut" }],
  } as any,
  "testnet"
);
check("investigate returns a verdict, not an analysis failure", p0.verdict !== "needs-review" || !/could not re-analyze/.test(p0.reasoning), `${p0.verdict}: ${p0.reasoning.slice(0, 80)}`);
check("the P0 is classified as suspicious", p0.verdict === "suspicious", `${p0.verdict} / ${p0.hypothesis}`);
check("the verdict carries the tier it came from", typeof p0.tier === "string" && p0.tier.length > 0, String(p0.tier));

// A digest that cannot be re-analyzed must degrade honestly rather than invent a verdict.
const dead = await investigate(
  { digest: "5RHbYgCHrtpWEWbc46Cj7DLqybY4moKDQUt6DxpmviR7", checkpoint: "1", violations: [{ type: "X", severity: "low", message: "m" }] } as any,
  "mainnet"
);
check("an unanalyzable digest comes back as needs-review, not benign", dead.verdict === "needs-review", `${dead.verdict} / ${dead.reasoning.slice(0, 60)}`);

console.log("\nbatch output shape");

const digests = path.join(os.tmpdir(), `chase-agent-batch-${process.pid}.txt`);
const out = path.join(os.tmpdir(), `chase-agent-batch-${process.pid}.ndjson`);
fs.writeFileSync(digests, "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg\nEpcqsX3RHDwpE2YAqHcfcKtDExjTBkz5FczQUk9PB4gp\n");
try {
  // batch exits 1 when a violation fires — that is the documented contract, not a failure. What would
  // be a failure is exit 2, which batch reserves for digests it could not analyse at all.
  const batchRun = run(["batch", digests, "-n", "testnet", "-o", out]);
  check("batch over resolvable digests exits 1 (violation found), not 2", batchRun.code === 1, `code=${batchRun.code} ${batchRun.out.slice(-120)}`);
  const raw = fs.readFileSync(out, "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  check("batch writes one NDJSON row per digest", rows.length === 2, String(rows.length));
  check("batch ends the file with a newline", raw.endsWith("\n"));
  check("batch rows carry violations, not just digests", rows.some((r) => (r.violations ?? []).length > 0));
  check("batch does not mark a successful analysis as an error", rows.every((r) => r.error === undefined));
} finally {
  fs.rmSync(digests, { force: true });
  fs.rmSync(out, { force: true });
}

console.log("\nargument validation (what a user sees first)");

function run(args: string[]): { code: number; out: string } {
  try {
    const o = execFileSync("npx", ["tsx", path.join(ROOT, "src/index.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, CHASE_CACHE_DIR: FIXTURES, CHASE_HISTORY_FILE: "" },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60000,
    });
    return { code: 0, out: o };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const badLimit = run(["watch", "--limit", "0"]);
check("watch rejects a zero limit before touching the network", badLimit.code === 2 && /positive whole number/.test(badLimit.out), `code=${badLimit.code}`);

const badFrom = run(["watch", "--from", "abc"]);
check("watch rejects a non-numeric --from", badFrom.code === 2 && /checkpoint number/.test(badFrom.out), `code=${badFrom.code}`);

const badNet = run(["analyze", "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg", "-n", "slopnet"]);
check("analyze rejects an unknown network", badNet.code === 2 && /unknown network/.test(badNet.out), `code=${badNet.code}`);

const badDigest = run(["analyze", "not-a-real-digest"]);
check("analyze rejects a malformed digest instead of probing the cache path", badDigest.code !== 0 && /digest/i.test(badDigest.out), `code=${badDigest.code}`);

const noStack = run(["hunt", "--target", PKG, "--reserve-judge", "abc"]);
check("bad input prints a message, not a stack trace", noStack.code === 2 && !/at .*\(.*:\d+:\d+\)/.test(noStack.out), noStack.out.split("\n")[0]?.slice(0, 80));

console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
