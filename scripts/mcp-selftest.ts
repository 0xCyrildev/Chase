#!/usr/bin/env npx tsx
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const LIVE = process.env.CHASE_MCP_LIVE === "1";
const ROOT = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(ROOT, "src", "mcp-server.ts");

const FIXTURES = path.join(ROOT, "test-cases", "fixtures");
const MAINNET_TX = "Eo4jC6v9qDADYM6ZwuxeiywftZPdzfPZfvgTSAqDRmT5";
const TESTNET_TX = "9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg";
const SYSTEM_TX = "4kcuJ7ThtJRuAKtF2U4frYf7AK7q8qFfsnNdp5t88XRq";

// Live cases fetch real transactions and the server caches whatever it fetches. Pointing that at the
// committed fixture set lets a test run mutate the thing that makes tests reproducible — 58 traces
// appeared in test-cases/fixtures/mainnet after one live run — so live mode works on a throwaway copy.
const cacheDir = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), "chase-selftest-")) : FIXTURES;
if (LIVE) fs.cpSync(FIXTURES, cacheDir, { recursive: true });

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

const client = new Client({ name: "chase-selftest", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    cwd: ROOT,
    env: { ...process.env, CHASE_CACHE_DIR: cacheDir } as any,
  })
);

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args } as any);
  const text = (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _text: text };
  }
  return { isError: !!res?.isError, parsed, text };
}

const EXPECTED = ["chase_analyze", "chase_query", "chase_watch", "chase_triage", "chase_investigate", "chase_list", "chase_hunt"];
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check(`tools/list exposes all ${EXPECTED.length} tools`, EXPECTED.every((e) => names.includes(e)), names.join(","));

console.log("\nchase_query");
const q = await call("chase_query", {});
check("responds without error", !q.isError);
check("reports a cache directory", typeof q.parsed?.cache_dir === "string");
check("reports where the watch positions live, read-only", q.parsed?.watch_cursor?.positions?.mainnet !== undefined,
  JSON.stringify(q.parsed?.watch_cursor ?? {}).slice(0, 120));

console.log("\nchase_analyze");
const a1 = await call("chase_analyze", { digest: MAINNET_TX, network: "mainnet" });
check("mainnet fixture analyzes", !a1.isError && Array.isArray(a1.parsed?.violations));
check("mainnet fixture reports its known violations", (a1.parsed?.violations?.length ?? 0) > 0);

const a2 = await call("chase_analyze", { digest: TESTNET_TX, network: "testnet" });
check(
  "testnet positive control still fires MUTABLE_REFERENCE_RETURNED",
  (a2.parsed?.violations ?? []).some((v: any) => v.type === "MUTABLE_REFERENCE_RETURNED")
);

const a3 = await call("chase_analyze", { digest: SYSTEM_TX, network: "mainnet" });
check("system transaction is a skip, not a tool error", !a3.isError && a3.parsed?.skipped === true,
  `isError=${a3.isError}`);

console.log("\nchase_triage");
const t1 = await call("chase_triage", { digests: [MAINNET_TX], network: "mainnet" });
check("triage returns tiered findings", !t1.isError && (t1.parsed?.findings?.length ?? 0) > 0);
check("every finding carries a tier and an action", (t1.parsed?.findings ?? []).every(
  (f: any) => typeof f.tier === "string" && typeof f.action === "string"
));

console.log("\nchase_investigate");
const inv = await call("chase_investigate", { digests: [MAINNET_TX], network: "mainnet", mode: "rules" });
check("investigates a fixture digest over MCP", !inv.isError && Array.isArray(inv.parsed?.readings),
  inv.text.slice(0, 160));
const reading = inv.parsed?.readings?.[0];
check("the reading comes back for the digest asked about", reading?.digest === MAINNET_TX, reading?.digest);
check("its evidence survives the JSON round trip rather than arriving as a verdict alone",
  !!reading?.evidence && Array.isArray(reading.evidence.commands) && reading.evidence.commands.length > 0,
  JSON.stringify(reading?.evidence ?? {}).slice(0, 160));
check("the trace was actually read, not reconstructed from the finding",
  (reading?.evidence?.commandCount ?? 0) > 0 &&
    !(reading?.evidence?.notes ?? []).some((n: string) => /trace unreadable/.test(n)),
  JSON.stringify(reading?.evidence?.notes ?? []));
check("signals come back as a list of what fired, and this fixture has none at high severity",
  Array.isArray(reading?.evidence?.signals), JSON.stringify(reading?.evidence?.signals ?? null));
check("the reading names the layer that formed it", reading?.source === "rules", String(reading?.source));
check("in words a consumer cannot mistake for a model's judgement",
  /rules layer, not a model/.test(reading?.provenance ?? ""), reading?.provenance);
check("triage's tier travels beside the reading, with whether hunt would have escalated it",
  typeof reading?.tier === "string" && typeof reading?.score === "number" && typeof reading?.escalated === "boolean",
  `${reading?.tier}/${reading?.escalated}`);
check("the response says a reading is not a vulnerability claim",
  /not a verdict on a contract/.test(inv.parsed?.caveat ?? ""), inv.parsed?.caveat);

const signalReading = await call("chase_investigate", { digests: [TESTNET_TX], network: "testnet", mode: "rules" });
const sigs = signalReading.parsed?.readings?.[0]?.evidence?.signals ?? [];
check("a high-severity signal carries the exact name it matched, so a tier can be argued with",
  sigs.length > 0 && sigs.every((s: any) => typeof s.type === "string" && Array.isArray(s.matched) && s.matched.length > 0) &&
    sigs.some((s: any) => /leak_mut/.test(s.matched.join(" "))),
  JSON.stringify(sigs).slice(0, 220));
check("and a reverted transaction says it reverted rather than reporting a success",
  signalReading.parsed?.readings?.[0]?.evidence?.success === false &&
    (signalReading.parsed?.readings?.[0]?.evidence?.notes ?? []).some((n: string) => /reverted/.test(n)),
  JSON.stringify(signalReading.parsed?.readings?.[0]?.evidence?.notes ?? []));

const mixed = await call("chase_investigate", { digests: [MAINNET_TX, SYSTEM_TX], network: "mainnet", mode: "rules" });
check("a system transaction is reported as not read, with its reason",
  (mixed.parsed?.readings?.length ?? 0) === 1 && (mixed.parsed?.notRead?.length ?? 0) === 1 &&
    mixed.parsed.notRead[0].digest === SYSTEM_TX && typeof mixed.parsed.notRead[0].reason === "string" &&
    mixed.parsed.notRead[0].reason.length > 10,
  JSON.stringify(mixed.parsed?.notRead ?? []));
check("and one unreadable digest does not void the reading already obtained",
  (mixed.parsed?.readings?.length ?? 0) === 1 && mixed.parsed?.requested === 2,
  `requested=${mixed.parsed?.requested} readings=${mixed.parsed?.readings?.length}`);

const tooMany = await call("chase_investigate", {
  digests: Array.from({ length: 11 }, () => MAINNET_TX),
  network: "mainnet",
});
check("more than ten digests is refused rather than run", tooMany.isError, tooMany.text.slice(0, 100));

if (LIVE) {
  console.log("\nlive network cases (CHASE_MCP_LIVE=1)");

  const w = await call("chase_watch", { from: 327157466, to: 327157466, network: "mainnet" });
  check("chase_watch reports coverage counts", !w.isError && typeof w.parsed?.coverage?.txsListed === "number");

  const l1 = await call("chase_list", {
    startCheckpoint: w.parsed?.coverage ? Number(w.parsed.to) - 40 : 0,
    endCheckpoint: Number(w.parsed?.to ?? 0),
    network: "mainnet",
    limit: 20,
  });
  check("chase_list unfiltered returns transactions", (l1.parsed?.count ?? 0) > 0);

  const bogus = "0x00000000000000000000000000000000000000000000000000000000000000aa";
  const l2 = await call("chase_list", {
    startCheckpoint: Number(w.parsed?.to ?? 0) - 40,
    endCheckpoint: Number(w.parsed?.to ?? 0),
    target: bogus,
    inspect: 5,
    network: "mainnet",
    limit: 20,
  });
  check(
    "chase_list still lists the range when a target matches nothing",
    (l2.parsed?.count ?? 0) > 0,
    `count=${l2.parsed?.count}`
  );
  check(
    "chase_list reports what it did not inspect instead of implying a clean range",
    /not inspected|NOT inspected/.test(l2.parsed?.presenceClaim ?? ""),
    l2.parsed?.presenceClaim
  );

  const l3 = await call("chase_list", {
    startCheckpoint: Number(w.parsed?.to ?? 0) - 40,
    endCheckpoint: Number(w.parsed?.to ?? 0),
    target: "0x2",
    inspect: 20,
    network: "mainnet",
    limit: 20,
  });
  check(
    "chase_list positive control: 0x2 is present in live transactions",
    (l3.parsed?.matchedCount ?? 0) > 0,
    `matched=${l3.parsed?.matchedCount} inspected=${l3.parsed?.inspected}`
  );

  const l4 = await call("chase_list", {
    startCheckpoint: Number(w.parsed?.to ?? 0) - 5,
    endCheckpoint: Number(w.parsed?.to ?? 0),
    target: "0x2",
    network: "mainnet",
  });
  check(
    "chase_list with inspect=0 makes no presence claim",
    /NOT CHECKED/.test(l4.parsed?.presenceClaim ?? ""),
    l4.parsed?.presenceClaim
  );

  const h = await call("chase_hunt", {
    target: "0xc72126457c84430ad439c8daf19679cfe87c84fc70912ba9b1df3060b64a5c50",
    mode: "rules",
    checkpoints: 10,
    passes: 1,
    maxRpcCalls: 40,
    maxWallMs: 120000,
    network: "mainnet",
  });
  check("chase_hunt runs the scout", !h.isError, h.parsed?._text?.slice(0, 120));
  check("chase_hunt reports verifiable coverage", typeof h.parsed?.coverage?.txsListed === "number");
  check("chase_hunt returns a summary", typeof h.parsed?.summary === "string" && h.parsed.summary.length > 20);
} else {
  console.log("\n(skipped live network cases — set CHASE_MCP_LIVE=1 to include them)");
}

await client.close();
if (LIVE) fs.rmSync(cacheDir, { recursive: true, force: true });

console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
