#!/usr/bin/env npx tsx
/**
 * Offline regression tests for the paths that only ever had manual evidence: the target matcher that
 * replaced the gRPC moveCall filter, the budget reserve that keeps triage from being starved, the
 * investigator, batch's output shape, and the argument validation that a CLI user sees first.
 *
 * Traces come from the committed fixtures and the history store is disabled, so a failure here means
 * the code changed, not that a fullnode moved. One exception, noted where it happens: the
 * "unanalyzable digest" case deliberately resolves nothing and so does reach the network — its
 * assertion (needs-review, never benign) holds with or without connectivity, because both a pruned
 * digest and an unreachable endpoint take the same path through investigate().
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

const { parseInvestigation } = await import("../src/agent/llm.js");
const rules = new (await import("../src/agent/rules-llm.js")).RuleBasedLLM();

// P0 fixture: a synthetic public &mut return, published to testnet. Committed trace, so the
// reading happens with no network in play.
const p0 = await investigate(
  {
    digest: "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg",
    checkpoint: "1",
    tier: "P0",
    score: 82,
    action: "ESCALATE",
    violations: [
      {
        type: "MUTABLE_REFERENCE_RETURNED",
        severity: "high",
        message: "returns &mut",
        evidence: {
          caller: "0x0000000000000000000000000000000000000001",
          package: "0x0000000000000000000000000000000000000002",
          module: "pricing",
          function: "update_price",
          commandIndex: 2,
        },
      },
    ],
  } as any,
  "testnet",
  (input: any) => rules.investigate(input)
);
check("the escalated transaction is actually read", p0.evidence.commandCount > 0, `${p0.evidence.commandCount} commands`);
check(
  "the evidence names the function the signal fired on",
  p0.evidence.signals.some((s: any) => s.matched.some((m: string) => m.includes("::"))),
  JSON.stringify(p0.evidence.signals).slice(0, 140)
);
check("a deterministic reading says it is deterministic", p0.source === "rules" && p0.degraded === false, `${p0.source}/${p0.degraded}`);
check("the P0 is classified as suspicious", p0.verdict === "suspicious", `${p0.verdict} / ${p0.hypothesis}`);
check("the verdict carries the tier it came from", p0.tier === "P0", String(p0.tier));
check("the reading is not a restatement of the tier", !/^Triage assigned tier/.test(p0.reasoning), p0.reasoning.slice(0, 60));

// An oracle escalation: every high signal came from a function-name match, which is not evidence of
// a state change. The honest deterministic answer is "a human must read the function".
const oracleOnly = await rules.investigate({
  digest: "A".repeat(44),
  network: "mainnet",
  tier: "P1",
  score: 55,
  action: "MANUAL_REVIEW",
  violations: [{ type: "ORACLE_MANIPULATION_SUSPECTED", severity: "high", message: "update then withdraw" }],
  evidence: {
    sender: "0x0000000000000000000000000000000000000001",
    success: true,
    commandCount: 12,
    commands: [],
    packages: [{ package: "0x00000000", calls: 9 }],
    signals: [
      {
        type: "ORACLE_MANIPULATION_SUSPECTED",
        severity: "high",
        matched: ["0x00000000::pool::update_price", "0x00000000::vault::withdraw"],
        count: 3,
      },
    ],
    movements: [],
    transfers: [],
    events: [],
    notes: [],
  },
});
check(
  "a name-match-only escalation is not called suspicious",
  oracleOnly.verdict === "needs-review",
  `${oracleOnly.verdict} / ${oracleOnly.hypothesis}`
);
check(
  "…and the reading says which signal it is deferring on",
  /ORACLE_MANIPULATION_SUSPECTED/.test(oracleOnly.reasoning),
  oracleOnly.reasoning.slice(0, 120)
);
check(
  "three identical firings collapse into one counted signal",
  oracleOnly.reasoning.includes("ORACLE_MANIPULATION_SUSPECTED×3"),
  oracleOnly.reasoning.slice(0, 100)
);

// The extractor that turns detector evidence into names, over the oracle shape the keyword detector
// actually emits. This is the part a reader checks a tier against.
const { describe: describeTrace } = await import("../src/agent/investigator.js");
const oracleTrace = {
  digest: "x",
  network: "mainnet",
  sender: `0x${"11".repeat(32)}`,
  success: true,
  balanceChanges: [],
  objectChanges: [],
  events: [],
  ptbCommands: [
    { index: 4, kind: "MoveCall", packageId: `0x${"ab".repeat(32)}`, module: "alpha_lending", function: "update_price" },
    { index: 21, kind: "MoveCall", packageId: `0x${"cd".repeat(32)}`, module: "router", function: "new_swap_context" },
  ],
};
const extracted = describeTrace(
  {
    digest: "x",
    violations: [
      {
        type: "ORACLE_MANIPULATION_SUSPECTED",
        severity: "high",
        message: "update then swap",
        evidence: {
          oracleCmd: oracleTrace.ptbCommands[0],
          defiCmd: oracleTrace.ptbCommands[1],
          oracleIndex: 4,
          defiIndex: 21,
        },
      },
      {
        type: "ORACLE_MANIPULATION_SUSPECTED",
        severity: "high",
        message: "update then swap",
        evidence: {
          oracleCmd: oracleTrace.ptbCommands[0],
          defiCmd: oracleTrace.ptbCommands[1],
          oracleIndex: 4,
          defiIndex: 21,
        },
      },
    ],
  } as any,
  oracleTrace as any
);
check(
  "a nested command pair is reported as the two names it matched",
  extracted.signals[0].matched.length === 2 &&
    extracted.signals[0].matched.some((m) => m.includes("alpha_lending::update_price")) &&
    extracted.signals[0].matched.some((m) => m.includes("router::new_swap_context")),
  JSON.stringify(extracted.signals[0].matched)
);
check(
  "identical firings collapse to one signal with a count",
  extracted.signals.length === 1 && extracted.signals[0].count === 2,
  JSON.stringify({ n: extracted.signals.length, count: extracted.signals[0].count })
);

// A model answer is only ever attributed to the model when the parse succeeded.
check(
  "a parsed model reading is labelled model",
  parseInvestigation('{"verdict":"benign","hypothesis":"feed refresh","reasoning":"ordinary withdrawal"}')?.source === "model",
  ""
);
check("an out-of-vocabulary verdict is refused, not defaulted", parseInvestigation('{"verdict":"exploit","hypothesis":"x","reasoning":"y"}') === null, "");
check("prose around the JSON is tolerated, junk is not", parseInvestigation("here you go:\n{\"verdict\":\"suspicious\",\"hypothesis\":\"h\",\"reasoning\":\"r\"}")?.verdict === "suspicious", "");
check(
  "a reading layer that throws is reported as a fallback, not as a verdict",
  (
    await investigate(
      { digest: "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg", violations: [], tier: "P1" } as any,
      "testnet",
      async () => {
        throw new Error("endpoint down");
      }
    )
  ).degraded === true,
  ""
);

// A digest with no committed trace must say the trace was unreadable rather than invent a reading.
// 5RHbYg… would not prove this: it is one of the two committed mainnet fixtures, so it reads offline.
// The endpoint is aimed at a closed local port, so the read cannot succeed on any digest.
process.env.SUI_RPC_URL = "https://127.0.0.1:1";
process.env.SUI_ARCHIVE_URL = "https://127.0.0.1:1";
const unreadable = await investigate(
  {
    digest: "HzQ9zQ7vkKcwNZKwcNVKcLbhUxjnTVKHrUJmBB8sQdBd",
    violations: [{ type: "X", severity: "low", message: "m" }],
    tier: "P2",
  } as any,
  "mainnet",
  (input: any) => rules.investigate(input)
);
delete process.env.SUI_RPC_URL;
delete process.env.SUI_ARCHIVE_URL;
check(
  "an unreadable digest comes back as needs-review, not benign",
  unreadable.verdict === "needs-review" && /trace unreadable/.test(unreadable.reasoning),
  `${unreadable.verdict} / ${unreadable.reasoning.slice(0, 80)}`
);
check("an unreadable digest still carries its notes", unreadable.evidence.notes.length > 0, JSON.stringify(unreadable.evidence.notes).slice(0, 100));

console.log("\nowner vocabulary (the kinds the SDK emits, not invented ones)");

const { SDK_OWNER_KINDS, ownerKindOf, ownerAddress } = await import("../src/lib/owner.js");

// mapOwner in @mysten/sui returns exactly these five shapes and throws on any other. Both
// ownership rules used to switch on `Parent` and `DerivedAddress`, which appear nowhere in the
// SDK: a branch that can never run still reads, to whoever is deciding whether an owner kind is
// covered, like coverage the tool has.
check(
  "the owner kinds named here are the five the SDK can emit",
  JSON.stringify([...SDK_OWNER_KINDS].sort()) ===
    JSON.stringify(["AddressOwner", "ConsensusAddressOwner", "Immutable", "ObjectOwner", "Shared"]),
  SDK_OWNER_KINDS.join(", ")
);

for (const invented of ["Parent", "DerivedAddress"]) {
  check(
    `ownerKindOf refuses the shape the SDK never emits: ${invented}`,
    ownerKindOf({ $kind: invented }) === undefined,
    String(ownerKindOf({ $kind: invented }))
  );
}

for (const f of ["src/invariants/ownership-anomaly.ts", "src/invariants/capability-transfer.ts"]) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8");
  check(
    `${f} reads one owner vocabulary instead of its own`,
    !/type OwnerKind/.test(text) && !/function ownerKindOf/.test(text)
  );
}

check("an address owner yields its address", ownerAddress({ $kind: "AddressOwner", AddressOwner: "0xabc" }) === "0xabc");
// The nesting is the whole story: an object owned by a consensus address IS owned by an address,
// and reading nothing here made such an object look like it had no address owner any more — the
// exact condition both ownership rules branch on.
check(
  "a consensus-address owner yields the address it nests",
  ownerAddress({ $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { startVersion: "7", owner: "0xdef" } }) === "0xdef"
);
check(
  "a consensus address is its own kind, not flattened into a plain address",
  ownerKindOf({ $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { owner: "0xdef" } }) === "consensus-address"
);
// ObjectOwner's value is an object id. Putting it in `recipient` would make a wrapped object read
// as a transfer to an address, which is a different claim than the one the field makes.
check("an object owner never becomes a recipient", ownerAddress({ $kind: "ObjectOwner", ObjectOwner: "0xdead" }) === undefined);

const { enrich: enrichReport, REPORT_ONLY_TYPES } = await import("../src/triage/enrich.js");
const declaredTypes = new Set(
  (await import("../src/invariants/index.js")).allInvariants.flatMap((c: any) =>
    (c.emits ?? []).map((e: any) => e.type)
  )
);

for (const t of REPORT_ONLY_TYPES) {
  check(`report-only type is one a checker actually declares: ${t}`, declaredTypes.has(t));
}

const repForEnrich: any = {
  digest: "x",
  network: "mainnet",
  sender: "0x1",
  success: true,
  violations: [
    { type: "REENTRANCY_PATTERN", severity: "medium", message: "m" },
    { type: "DYNAMIC_FIELD_CREATED", severity: "low", message: "f" },
    { type: "ORACLE_MANIPULATION_SUSPECTED", severity: "high", message: "o" },
  ],
  detectorErrors: [],
  skipped: [],
  stats: { balanceChanges: 0, objectChanges: 0, ptbCommands: 0, events: 0 },
};
const enriched = await enrichReport(repForEnrich);
const reRow = enriched.find((x) => x.violation.type === "REENTRANCY_PATTERN")!;
check(
  "a report-only shape does not raise another finding's priority",
  !reRow.corroborating.some((v: any) => v.type === "DYNAMIC_FIELD_CREATED"),
  JSON.stringify(reRow.corroborating.map((v: any) => v.type))
);
check(
  "an ordinary independent signal still corroborates",
  reRow.corroborating.some((v: any) => v.type === "ORACLE_MANIPULATION_SUSPECTED")
);
check(
  "and a report-only finding is still escalated by what surrounds it",
  enriched.find((x) => x.violation.type === "DYNAMIC_FIELD_CREATED")!.corroborating.length > 0
);

console.log("\nowner recording (a cached trace must answer what a live one answered)");

const { outputOwnerOf } = await import("../src/lib/owner.js");
const { saveTrace, loadTrace } = await import("../src/lib/cache.js");
const { ownershipAnomaly } = await import("../src/invariants/ownership-anomaly.js");

const wrapped = {
  objectId: "0xaaa",
  objectType: "0x5::pool::Pool",
  changeType: "mutated",
  outputOwnerKind: "object",
  outputOwnerId: "0x80f9cb39d2f80d3d4b6f78a4c1e2d3f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
};
check("a recorded owner kind is read back verbatim", outputOwnerOf(wrapped as any).kind === "object");
check("an object owner names the object that owns it", typeof outputOwnerOf(wrapped as any).objectId === "string");

// Traces normalised before owners were recorded: no kind, no recipient. Saying `unresolved` here
// would claim a lookup that never happened.
check(
  "an owner that was never recorded is unrecorded, not unresolved",
  outputOwnerOf({ objectId: "0xaaa", objectType: "0x5::pool::Pool", changeType: "mutated" } as any).kind ===
    "unrecorded"
);

const naming = ownershipAnomaly.check(
  trace({ sender: "0xs", objectChanges: [{ ...wrapped, sender: "0xs" }] })
);
check(
  "a change into an object owner names the parent object in the finding",
  naming.length === 1 && String(naming[0].message).includes("0x80f9cb39"),
  naming[0]?.message ?? "no violation"
);

const legacy = ownershipAnomaly.check(
  trace({
    sender: "0xs",
    objectChanges: [{ objectId: "0xaaa", objectType: "0x5::pool::Pool", changeType: "mutated", sender: "0xs" }],
  })
);
check(
  "an unrecorded owner is stated as unrecorded, and says how to resolve it",
  legacy.length === 1 &&
    legacy[0].evidence?.recipientKind === "unrecorded" &&
    /not recorded for this cached trace/.test(String(legacy[0].evidence?.note)),
  JSON.stringify(legacy[0]?.evidence ?? null)
);

// The round trip is the point of the change: an owner read on a first fetch has to still be there
// on the second one. CHASE_CACHE_DIR is re-read per call for exactly this test — the process
// already pointed it at the committed fixtures, and writing there would edit the corpus.
const RT_DIGEST = "5RHbYgCHrtpWEWbc46Cj7DLqybY4moKDQUt6DxpmviR7";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "chase-cache-"));
const previousCacheDir = process.env.CHASE_CACHE_DIR;
process.env.CHASE_CACHE_DIR = scratch;
try {
  saveTrace(trace({ digest: RT_DIGEST, network: "mainnet", sender: "0xs", objectChanges: [wrapped] }));
  const back = loadTrace(RT_DIGEST, "mainnet");
  check("the recorded owner survives save → load", back?.objectChanges?.[0]?.outputOwnerKind === "object");
  check("and so does the parent id", typeof back?.objectChanges?.[0]?.outputOwnerId === "string");
  const onDisk = JSON.parse(fs.readFileSync(path.join(scratch, "mainnet", `${RT_DIGEST}.json`), "utf8"));
  check("a cached trace stamps the schema it was normalised under", onDisk.schema === 2, String(onDisk.schema));
  check("raw is gone from what gets written", !("raw" in onDisk));
} finally {
  if (previousCacheDir === undefined) delete process.env.CHASE_CACHE_DIR;
  else process.env.CHASE_CACHE_DIR = previousCacheDir;
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("\ndetector declarations (triage must have an opinion about every type)");

const { allInvariants } = await import("../src/invariants/index.js");
const { EXPECTED_OVERLAP } = await import("../src/triage/enrich.js");
const triageConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "triage", "triage.config.json"), "utf8")
);
const knownTxs = JSON.parse(fs.readFileSync(path.join(ROOT, "test-cases", "known-txs.json"), "utf8"));
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

const declared = allInvariants.flatMap((c: any) =>
  (c.emits ?? []).map((e: any) => ({ checker: c.name, ...e }))
);
const modifier = triageConfig.confidenceModifier;
const weight = triageConfig.severityWeights;

// Types whose fixture is a triage case rather than an analyze case, or which have no positive
// control in this repo yet. Anything absent from both lists must be asserted by known-txs.json,
// or this gate is checking an empty set and passing.
const NO_POSITIVE_CONTROL: string[] = [];

check("every checker declares at least one type", allInvariants.every((c: any) => (c.emits ?? []).length > 0));

for (const e of declared) {
  check(`${e.type} has a deliberate confidenceModifier`, Object.prototype.hasOwnProperty.call(modifier, e.type), "scoring falls back to ?? 0 and the detector is silently ignored");
  check(`${e.type} severity has a weight`, typeof weight[e.severity] === "number", `severity=${e.severity}`);
}

const owners = new Map<string, string[]>();
for (const e of declared) owners.set(e.type, [...(owners.get(e.type) ?? []), e.checker]);
for (const [t, cs] of owners) {
  check(`${t} is claimed by exactly one checker`, cs.length === 1, cs.join(", "));
}

for (const [a, b] of EXPECTED_OVERLAP as [string, string][]) {
  for (const t of [a, b]) {
    check(`overlap names a declared type: ${t}`, owners.has(t), "a typo here silently re-enables corroboration inflation");
  }
}

for (const key of Object.keys(modifier)) {
  check(`no orphan confidenceModifier: ${key}`, owners.has(key), "a retired detector keeps scoring");
}

for (const c of allInvariants) {
  check(`README documents the ${c.name} check`, readme.includes(`### ${c.name}`));
}

for (const t of owners.keys()) {
  check(`${t} appears in the README modifier table`, new RegExp(`\\| *${t} *\\|`).test(readme),
    "the table is what a reader trusts to explain scoring; config drift shows up here first");
}

const asserted = new Set(
  (Array.isArray(knownTxs) ? knownTxs : (knownTxs.cases ?? [])).flatMap(
    (k: any) => k.expectViolationTypes ?? []
  )
);
for (const t of owners.keys()) {
  check(
    `${t} has a positive control or is listed as uncontrolled`,
    asserted.has(t) || NO_POSITIVE_CONTROL.includes(t),
    asserted.has(t) ? "" : "add a fixture case or say why not in NO_POSITIVE_CONTROL"
  );
}

// Declarations can drift from code: scripts/ is never typechecked, so scan the source text too.
for (const f of fs.readdirSync(path.join(ROOT, "src", "invariants"))) {
  if (!f.endsWith(".ts") || f === "index.ts") continue;
  const text = fs.readFileSync(path.join(ROOT, "src", "invariants", f), "utf8");
  const checker = allInvariants.find((c: any) => c.name === f.replace(/\.ts$/, "").replace(/_/g, "-"));
  if (!checker) continue;
  const literals = [...text.matchAll(/type: "([A-Z][A-Z0-9_]+)"/g)].map((m: any) => m[1]);
  for (const lit of new Set(literals)) {
    check(
      `${f} declares the type it emits: ${lit}`,
      (checker as any).emits.some((e: any) => e.type === lit),
      "emitted but undeclared — it will score with the default modifier"
    );
  }
}

console.log("\ndry-run coverage (the published artifact surfaced this one)");

const { scout } = await import("../src/agent/scout.js");
const { RuleBasedLLM } = await import("../src/agent/rules-llm.js");
const { coverageCaveat, toMarkdown } = await import("../src/agent/report-md.js");

const emptyCov = {
  passes: 0, startCheckpoint: null, endCheckpoint: null, checkpointsScanned: 0,
  txsListed: 0, txsAnalyzed: 0, txsSkipped: 0, txsTargetMissed: 0, txsCarried: 0,
  txsErrored: 0, complete: true, analysisComplete: true,
};
check("an empty coverage object is never called a complete sweep", !/complete — every listed transaction reached/.test(coverageCaveat(emptyCov as any)) && /^NO SCAN RAN/.test(coverageCaveat(emptyCov as any)), coverageCaveat(emptyCov as any));

const dry = await scout(
  { target: PKG, checkpoints: 2, goal: "dry-run honesty", budget: { maxRpcCalls: 4, maxLlmCalls: 3, maxLlmTokens: 5000, maxWallMs: 30000 } },
  new RuleBasedLLM(),
  { dryRun: true, network: "mainnet" }
);
check("a dry-run completes without touching the chain", dry.usage.rpcCalls === 0, `rpc=${dry.usage.rpcCalls}`);
check("dry-run coverage does not report 'complete'", !/^complete/.test(coverageCaveat(dry.coverage)), coverageCaveat(dry.coverage));
check("dry-run coverage names the reason", /NO SCAN RAN/.test(coverageCaveat(dry.coverage)), coverageCaveat(dry.coverage));
check("dry-run summary refuses to read as a result", /NOTHING SCANNED/.test(dry.summary), dry.summary.slice(-90));

console.log("\ncorroboration independence (found in live traffic, 308 txs)");

// Measured: the only two transactions that reached P2 were Cetus flash swaps. FLASH_LOAN_SHAPED,
// REPEATED_MODULE_CALLS and REENTRANCY_PATTERN all fired because they describe one construct — a
// borrow/action/repay that calls the same pool module several times in sequence — so the score read
// "3 independent detectors agree" when one shape was counted three times.
const { enrich } = await import("../src/triage/enrich.js");
const flashSwapReport: any = {
  digest: "f", network: "mainnet", timestamp: "", sender: "0x1", success: true, detectorErrors: [],
  stats: { balanceChanges: 1, objectChanges: 1, ptbCommands: 22, events: 0 },
  violations: [
    { type: "FLASH_LOAN_SHAPED", severity: "medium", message: "borrow/action/repay", evidence: { package: PKG } },
    { type: "REPEATED_MODULE_CALLS", severity: "low", message: "pool called 8 times", evidence: { package: PKG } },
    { type: "REENTRANCY_PATTERN", severity: "medium", message: "flash_swap re-entered", evidence: { package: PKG } },
    { type: "CAPABILITY_TRANSFER", severity: "high", message: "cap moved", evidence: { package: PKG } },
  ],
};
const enrichedFlash = await enrich(flashSwapReport);
const byType = new Map(enrichedFlash.map((e) => [e.violation.type, e.corroborating.map((c) => c.type)]));
const CLUSTER = new Set(["FLASH_LOAN_SHAPED", "REPEATED_MODULE_CALLS", "REENTRANCY_PATTERN"]);
const leaked = (t: string) => (byType.get(t) ?? []).filter((x) => CLUSTER.has(x));

check("flash-swap shape is not corroborated by its own symptoms", leaked("FLASH_LOAN_SHAPED").length === 0, leaked("FLASH_LOAN_SHAPED").join(","));
check("reentrancy is not corroborated by repeated calls of the same call", leaked("REENTRANCY_PATTERN").length === 0, leaked("REENTRANCY_PATTERN").join(","));
check("repeated calls are not corroborated by the flash shape", leaked("REPEATED_MODULE_CALLS").length === 0, leaked("REPEATED_MODULE_CALLS").join(","));
check("an orthogonal detector still corroborates all three", [...CLUSTER].every((t) => (byType.get(t) ?? []).includes("CAPABILITY_TRANSFER")),
  [...CLUSTER].map((t) => `${t}=[${(byType.get(t) ?? []).join("|")}]`).join(" "));
check("the orthogonal finding keeps the cluster in its own corroboration", (byType.get("CAPABILITY_TRANSFER") ?? []).length === 3,
  (byType.get("CAPABILITY_TRANSFER") ?? []).join(","));

console.log("\npublish identity (npm ci checks this; a local run should too)");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const lockRoot = lock.packages?.[""] ?? {};
check("package.json and the lockfile name agree", lockRoot.name === pkg.name, `${lockRoot.name} vs ${pkg.name}`);
check("package.json and the lockfile version agree", lockRoot.version === pkg.version, `${lockRoot.version} vs ${pkg.version}`);
check("version.ts reads the same value the manifest declares", (await import("../src/lib/version.js")).VERSION === pkg.version);
check("the package is scoped to the npm username, not the GitHub handle", pkg.name.startsWith("@zeroxcyril/"), pkg.name);

console.log("\nexplicit transaction list — the escalation path, offline");

// The first version of this feature passed every eyeball test and did nothing: `--txs` parsed, the
// target label read "explicit:7 tx(s)", and the scout then swept checkpoints anyway because the
// parsed list was never put back into the mandate. A silently ignored flag is worse than a missing
// one, so each of these asserts on the value the scout actually receives.
const P0_TX = "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg";
const P1_TX = "AyBucbogeLhR895L5SDyYucPwsA3gJLcmNn84krjiGEV";
const txsFile = path.join(os.tmpdir(), `chase-txs-${process.pid}.txt`);
fs.writeFileSync(txsFile, `# synthetic testnet positive controls\n${P0_TX}\n${P1_TX}\n`);

const mTxs = mandateFromArgs({ txs: txsFile });
check("--txs survives into the mandate", mTxs.txs?.length === 2, String(mTxs.txs?.length));
check("comments and blanks are stripped from a digest file", (mTxs.txs ?? []).every((d) => d.length > 40));
check("a named list labels its own target", /^explicit:2 tx/.test(mTxs.target), mTxs.target);
check("a junk line is rejected rather than quietly skipped", (() => {
  const badFile = path.join(os.tmpdir(), `chase-txs-bad-${process.pid}.txt`);
  fs.writeFileSync(badFile, `${P0_TX}\nnot-a-digest\n`);
  try {
    mandateFromArgs({ txs: badFile });
    return false;
  } catch (e: any) {
    return /invalid digest/i.test(String(e?.message));
  } finally {
    fs.rmSync(badFile, { force: true });
  }
})());

const escalated = await scout(
  {
    target: mTxs.target,
    checkpoints: 20,
    goal: "escalation path proof",
    txs: [P0_TX, P1_TX],
    budget: { maxRpcCalls: 60, maxLlmCalls: 8, maxLlmTokens: 40000, maxWallMs: 120000 },
  },
  new RuleBasedLLM(),
  { network: "testnet", verbose: false }
);
const ef = escalated.findings;
check("exactly the named transactions were analyzed", escalated.coverage.txsListed === 2 && ef.length === 2,
  `listed=${escalated.coverage.txsListed} findings=${ef.length}`);
check("an explicit run claims no checkpoint coverage", escalated.coverage.checkpointsScanned === 0,
  String(escalated.coverage.checkpointsScanned));
check("and does not invent a seq range to fill the gap", escalated.coverage.startCheckpoint === null && escalated.coverage.endCheckpoint === null,
  `${escalated.coverage.startCheckpoint}..${escalated.coverage.endCheckpoint}`);
check("one pass, then stop", escalated.coverage.passes === 1, String(escalated.coverage.passes));
check("nothing was left untiered", ef.every((f) => !!f.tier && !f.tierError), ef.map((f) => f.tierError ?? f.tier).join(","));
check("the P0 escalates", ef.find((f) => f.digest === P0_TX)?.action === "ESCALATE",
  JSON.stringify(ef.map((f) => [f.tier, f.action])));

const inv = ef.find((f) => f.digest === P0_TX)?.investigation;
check("THE INVESTIGATOR ACTUALLY RAN", !!inv, "no investigation attached to the P0");
check("and it reached a verdict, not a shrug", inv?.verdict === "suspicious" && !!inv.hypothesis && inv.hypothesis !== "unclassified",
  `${inv?.verdict} / ${inv?.hypothesis} / ${inv?.reasoning?.slice(0, 60)}`);
check("the reading names the layer that produced it", inv?.source === "rules" && inv?.degraded === false,
  `${inv?.source}/${inv?.degraded}`);
check("the reading cites a transaction it actually read", (inv?.evidence.commandCount ?? 0) > 0,
  String(inv?.evidence.commandCount));
check("detector evidence survives from analysis into the finding",
  ef.some((f) => f.violations.some((v) => v.evidence !== undefined)),
  JSON.stringify(ef[0]?.violations?.[0]?.evidence ?? null).slice(0, 60));
check("a real escalation's evidence names what actually fired",
  (inv?.evidence.signals ?? []).some((s: any) => s.matched.length > 0),
  JSON.stringify(inv?.evidence.signals ?? []).slice(0, 160));

// A reading nobody can see is a reading that did not happen: both renderers must carry the verdict,
// the evidence line and the provenance label.
const md = toMarkdown(escalated);
check("markdown renders the verdict with its provenance",
  /Investigator:.*\(rules layer, not a model\)/s.test(md), md.match(/Investigator:.*/s)?.[0]?.slice(0, 90) ?? "absent");
check("markdown renders what was read", /read: \d+ cmds/.test(md), md.match(/read: .*/)?.[0]?.slice(0, 80) ?? "absent");
const inv1 = ef.find((f) => f.digest === P1_TX)?.investigation;
check("the capability transfer escalated too", !!inv1 && (ef.find((f) => f.digest === P1_TX)?.tier ?? "") !== "NOISE",
  `${ef.find((f) => f.digest === P1_TX)?.tier} / ${inv1?.verdict}`);
fs.rmSync(txsFile, { force: true });

console.log("\ndetector shapes the keyword lists used to miss");

const { flashLoanShaped } = await import("../src/invariants/flash-loan-shaped.js");
const mc = (index: number, module: string, fn: string) => ({ index, kind: "MoveCall", packageId: `0x${"ab".repeat(32)}`, module, function: fn });
const cetusFlash = flashLoanShaped.check({
  ptbCommands: [
    mc(11, "pool", "flash_swap"),
    mc(14, "pool", "swap_exact_one_for_amount"),
    mc(17, "pool", "repay_flash_swap"),
  ],
} as any);
check(
  "a Cetus flash_swap → swap → repay_flash_swap sequence is recognised",
  cetusFlash.some((v) => v.type === "FLASH_LOAN_SHAPED"),
  JSON.stringify(cetusFlash.map((v) => v.message))
);
const noActionInBetween = flashLoanShaped.check({
  ptbCommands: [mc(0, "pool", "flash_swap"), mc(1, "pool", "repay_flash_swap")],
} as any);
check(
  "…and a bare borrow/repay pair with no action between them is not",
  noActionInBetween.length === 0,
  JSON.stringify(noActionInBetween.map((v) => v.type))
);

console.log("\nendpoint configuration (the retention escape hatch)");

const { TraceFetcher } = await import("../src/lib/fetcher.js");
const savedRpc = process.env.SUI_RPC_URL;
const savedArchive = process.env.SUI_ARCHIVE_URL;
try {
  delete process.env.SUI_RPC_URL;
  delete process.env.SUI_ARCHIVE_URL;
  const constructs = (which: "mainnet" | "testnet") => {
    try {
      void new TraceFetcher(which);
      return true;
    } catch {
      return false;
    }
  };
  check("with no override, a fetcher still constructs for mainnet", constructs("mainnet"));
  process.env.SUI_RPC_URL = "http://example.com:443";
  let msg = "";
  try { new TraceFetcher("mainnet"); } catch (e: any) { msg = String(e?.message); }
  check("a plain http endpoint is refused, not silently used", /https:\/\/ URL/.test(msg), msg.slice(0, 70));
  process.env.SUI_RPC_URL = "   ";
  check("a blank override falls back to the default rather than erroring", constructs("mainnet"));
  process.env.SUI_RPC_URL = "https://rpc.provider.example/v1";
  process.env.SUI_ARCHIVE_URL = "https://archive.provider.example/v1";
  check("valid https overrides construct", constructs("testnet"));
} finally {
  if (savedRpc === undefined) delete process.env.SUI_RPC_URL; else process.env.SUI_RPC_URL = savedRpc;
  if (savedArchive === undefined) delete process.env.SUI_ARCHIVE_URL; else process.env.SUI_ARCHIVE_URL = savedArchive;
}

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
