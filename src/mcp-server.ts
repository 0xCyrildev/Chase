#!/usr/bin/env node
import "./lib/undici-setup.js";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAnalysis, resolveNetwork } from "./commands/analyze.js";
import { TraceFetcher, NonProgrammableTransaction } from "./lib/fetcher.js";
import { signatureCacheSize } from "./lib/sigcache.js";
import { cacheDir } from "./lib/cache.js";
import { isDigest } from "./lib/digest.js";
import { parseTarget, traceTouchesTarget } from "./lib/target.js";
import { triage } from "./triage/index.js";
import { scout } from "./agent/scout.js";
import { investigate } from "./agent/investigator.js";
import { evidenceLine, investigationProvenance } from "./agent/report-md.js";
import { validateMandate } from "./agent/mandate.js";
import { RealLLM } from "./agent/llm.js";
import { StubLLM } from "./agent/stub-llm.js";
import { RuleBasedLLM } from "./agent/rules-llm.js";
import { CURSOR_NETWORKS, cursorPath, cursorStatus } from "./lib/cursor.js";
import { VERSION } from "./lib/version.js";

// An MCP client launches this from its own working directory, so without this the LLM-backed
// modes silently degrade instead of reading the project's .env.
dotenv.config({ quiet: true, path: process.env.CHASE_ENV_FILE });

const digestSchema = z
  .string()
  .refine(isDigest, "not a Sui transaction digest (base58, 40-60 chars)");

const server = new McpServer({
  name: "chase",
  version: VERSION,
});

server.tool(
  "chase_analyze",
  "Analyze a Sui Move transaction by digest. Fetches the execution trace over gRPC and runs invariant checks (mutable-access, oracle-pattern, ownership-anomaly, reentrancy-pattern, etc). Returns violations with severity and evidence.",
  {
    digest: digestSchema.describe("Transaction digest (base58, e.g. 5RHbYgCHr...)"),
    network: z
      .enum(["mainnet", "testnet", "devnet"])
      .default("mainnet")
      .describe("Sui network to query"),
    debug: z.boolean().default(false).describe("Include per-command and per-object debug output"),
    useCache: z
      .boolean()
      .default(true)
      .describe("Read the local trace cache first. Set false to re-fetch from the endpoint, which is what `chase analyze --no-cache` does"),
  },
  async ({ digest, network, debug, useCache }) => {
    try {
      const report = await runAnalysis(digest, debug, useCache, network);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                digest: report.digest,
                network: report.network,
                status: report.success ? "success" : "failed",
                sender: report.sender,
                violations: report.violations.map((v) => ({
                  type: v.type,
                  severity: v.severity,
                  message: v.message,
                  evidence: v.evidence,
                })),
                stats: report.stats,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      if (err instanceof NonProgrammableTransaction) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ digest, network, skipped: true, reason: err.message }, null, 2),
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `Error analyzing ${digest}: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "chase_query",
  "Query Chase's local cache. Returns how many Move function signatures are cached, the cache directory " +
    "path, and where `chase watch` left on each network. The watch position is read, never written, by this call.",
  {},
  async () => {
    const positions: Record<string, unknown> = {};
    for (const network of CURSOR_NETWORKS) {
      const s = cursorStatus(network);
      positions[network] =
        s.state === "saved" && s.entry
          ? { checkpoint: s.entry.checkpoint, savedAt: s.entry.savedAt, gaps: s.entry.gaps }
          : { state: s.state, detail: s.detail };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              signatures_cached: signatureCacheSize(),
              cache_dir: cacheDir(),
              watch_cursor: { path: cursorPath(), positions },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "chase_watch",
  "Scan a range of Sui checkpoints, running invariants on each transaction. Returns any findings. Bounded " +
    "to a small range to keep the call responsive. This call is stateless: it neither reads nor writes the " +
    "position that the `chase watch` CLI command saves to resume a monitor, so nothing here advances or " +
    "rewinds what `chase watch --status` reports.",
  {
    from: z.number().int().nonnegative().describe("Starting checkpoint sequence number (inclusive)"),
    to: z.number().int().nonnegative().describe("Ending checkpoint sequence number (inclusive); at most 20 checkpoints past `from`"),
    network: z
      .enum(["mainnet", "testnet", "devnet"])
      .default("mainnet")
      .describe("Sui network to scan"),
    filter: z
      .string()
      .optional()
      .describe("Only report findings whose evidence contains this substring (e.g. a package ID)"),
  },
  async ({ from, to, network, filter }) => {
    if (to < from || to - from > 20) {
      return {
        content: [
          {
            type: "text",
            text: `range ${from}..${to} rejected: keep it at or below 20 checkpoints, or use chase_hunt`,
          },
        ],
        isError: true,
      };
    }

    const fetcher = new TraceFetcher(network, true);
    const findings: any[] = [];
    const errors: any[] = [];
    let txsListed = 0;
    let txsAnalyzed = 0;
    let txsSkipped = 0;
    let txsErrored = 0;

    for (let seq = BigInt(from); seq <= BigInt(to); seq++) {
      let digests: string[] = [];
      try {
        digests = await fetcher.getCheckpointTransactions(seq);
      } catch (err: any) {
        // A checkpoint that could not be read is not a finding, and must not be counted as one.
        errors.push({ checkpoint: seq.toString(), error: String(err?.message ?? err).slice(0, 200) });
        continue;
      }

      txsListed += digests.length;

      for (const digest of digests) {
        try {
          const report = await runAnalysis(digest, false, true, network);
          txsAnalyzed++;
          if (filter) {
            const touches = report.violations.some((v) =>
              JSON.stringify(v.evidence ?? {}).includes(filter)
            );
            if (!touches) continue;
          }
          if (report.violations.length > 0) {
            findings.push({
              checkpoint: seq.toString(),
              digest,
              violations: report.violations.map((v) => ({ type: v.type, severity: v.severity })),
            });
          }
        } catch (err: any) {
          if (err instanceof NonProgrammableTransaction) {
            txsSkipped++;
          } else {
            txsErrored++;
          }
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              from,
              to,
              network,
              coverage: {
                checkpointsRequested: to - from + 1,
                checkpointsUnreadable: errors.length,
                complete: errors.length === 0,
                txsListed,
                txsAnalyzed,
                txsSkipped,
                txsErrored,
              },
              findings,
              errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "chase_triage",
  "Run the triage layer over one or more Sui Move transaction digests. Fetches traces via Chase, applies benign-pattern matching and confidence scoring, and returns prioritized findings with tier (P0-P3, NOISE) and recommended action (DISMISS, MANUAL_REVIEW, ESCALATE).",
  {
    digests: z
      .array(digestSchema)
      .min(1)
      .max(50)
      .describe("Array of transaction digests to triage"),
    network: z
      .enum(["mainnet", "testnet", "devnet"])
      .default("mainnet")
      .describe("Sui network to query"),
    minTier: z
      .enum(["P0", "P1", "P2", "P3", "NOISE"])
      .optional()
      .describe("Only return findings at this tier or above"),
    explain: z
      .boolean()
      .default(false)
      .describe(
        "Ask the configured model for prose on each finding. Off by default: without a key it degrades to the deterministic rationale, and a degraded explanation is labelled as one"
      ),
  },
  async ({ digests, network, minTier, explain }) => {
    try {
      const report = await triage(digests, {
        network,
        minTier: minTier as any,
        explain,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                digests: report.digests,
                summary: report.summary,
                // A digest that could not be analyzed has to be named, not simply absent from
                // findings: absence here would otherwise read as "clean" to anything routing
                // through this tool.
                skipped: report.skipped,
                findings: report.findings.map((f) => ({
                  digest: f.digest,
                  type: f.violation.type,
                  severity: f.violation.severity,
                  tier: f.tier,
                  score: f.score,
                  message: f.violation.message,
                  rationale: f.rationale,
                  explanation: f.explanation,
                  benignMatch: f.benignMatch,
                  action: f.nextAction,
                  confidence: f.confidence,
                })),
                caveats: report.caveats,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error triaging: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }
);

const ESCALATED_TIERS = new Set(["P0", "P1", "P2"]);

server.tool(
  "chase_investigate",
  "Read named transactions the way an investigator reads one, instead of re-scoring them: one trace " +
    "fetch per digest, then the PTB commands in order, the packages by call count, the largest coin " +
    "movements, what changed hands, and the exact names each high-severity signal fired on. The verdict " +
    "is asked of the decision layer you name (`rules` is deterministic and needs no API key, `real` asks " +
    "the configured provider and is what `chase_hunt` would have charged a budget for). Every reading " +
    "carries `source` so a table lookup cannot be mistaken for a model's judgement, plus the `evidence` " +
    "behind it. Triage runs first and its tier is returned beside the reading: this tool reads what it " +
    "is handed and does not decide which transactions deserve reading, which is what chase_hunt does. " +
    "A digest with nothing to read appears under `notRead` with its reason, never as an absent finding.",
  {
    digests: z
      .array(digestSchema)
      .min(1)
      .max(10)
      .describe("Transaction digests to read (up to 10, one trace fetch each)"),
    network: z
      .enum(["mainnet", "testnet", "devnet"])
      .default("mainnet")
      .describe("Sui network to query"),
    mode: z
      .enum(["rules", "real", "stub"])
      .default("rules")
      .describe(
        "Which layer forms the reading: 'rules' is deterministic and reproducible with no key, 'real' is the configured LLM, 'stub' is for testing"
      ),
  },
  async ({ digests, network, mode }) => {
    const llm =
      mode === "real" ? new RealLLM() : mode === "stub" ? new StubLLM() : new RuleBasedLLM();

    const readings: any[] = [];
    const notRead: { digest: string; reason: string }[] = [];

    try {
      // NOISE included, so a deliberately dismissed finding stays distinguishable from a failure.
      const report = await triage(Array.from(new Set(digests)), { network, minTier: "NOISE" });
      const skipped = new Map(report.skipped.map((s) => [s.digest, s.reason]));

      for (const digest of new Set(digests)) {
        // formatReport sorts by score, so the first finding for this digest is its strongest.
        const mine = report.findings.filter((f) => f.digest === digest);
        const top = mine[0];
        if (!top) {
          notRead.push({
            digest,
            reason: skipped.get(digest) ?? "analyzed, no violations, so there was nothing to read",
          });
          continue;
        }

        const finding = {
          digest,
          violations: mine.map((f) => ({
            type: f.violation.type,
            severity: f.violation.severity,
            message: f.violation.message,
            evidence: f.violation.evidence,
          })),
          tier: top.tier,
          score: top.score,
          action: top.nextAction,
        };

        try {
          // One read per digest, not two: triage fetched this trace and cached it, and the violations
          // travel on the finding rather than being re-derived by the investigator.
          const inv = await investigate(finding, network, (input) => llm.investigate(input));
          readings.push({
            ...inv,
            network,
            escalated: ESCALATED_TIERS.has(top.tier),
            provenance: investigationProvenance(inv),
            evidenceLine: evidenceLine(inv.evidence),
          });
        } catch (err: any) {
          notRead.push({
            digest,
            reason: `investigation failed: ${String(err?.message ?? err).slice(0, 200)}`,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                network,
                mode,
                requested: Array.from(new Set(digests)).length,
                readings,
                notRead,
                caveat:
                  "A reading is Chase's, not a verdict on a contract: nothing here claims a " +
                  "vulnerability. The escalation threshold (P0-P2) is chase_hunt's policy for what to " +
                  "read unprompted, so check `tier` and `escalated` before putting a reading in a " +
                  "report. A digest under `notRead` was not read; that is not the same as being clean.",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error investigating: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "chase_list",
  "List transactions in a checkpoint range. Do not use this to prove a protocol is quiet: the gRPC " +
    "MoveCall listing filter is deliberately not applied, because measured on mainnet it answered " +
    "'nothing, complete=true' for `0x2::transfer` and for a Cetus package id that 8% of the sampled " +
    "transactions demonstrably swapped through. Pass `target` with `inspect` > 0 to get a real presence " +
    "check: chase fetches that many traces and matches the package against each transaction's own calls, " +
    "event types and object types. Routed volume names the router in a top-level call, so this is the " +
    "only honest way to answer 'was this called here'. The response always reports listed, inspected and " +
    "uninspected counts; a 0-match result over a partial inspection says nothing about the rest.",
  {
    startCheckpoint: z.number().int().nonnegative().describe("First checkpoint sequence number (inclusive)"),
    endCheckpoint: z.number().int().nonnegative().describe("Last checkpoint sequence number (inclusive); at most 500 wide"),
    target: z
      .string()
      .optional()
      .describe("Package id, or pkg::module / pkg::module::function, to verify presence of"),
    inspect: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe("Traces to fetch for the presence check (0 = listing only, makes no presence claim)"),
    network: z.enum(["mainnet", "testnet", "devnet"]).default("mainnet"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max digests to return"),
  },
  async ({ startCheckpoint, endCheckpoint, target, inspect, network, limit }) => {
    if (endCheckpoint < startCheckpoint) {
      return {
        content: [{ type: "text", text: "endCheckpoint must be >= startCheckpoint" }],
        isError: true,
      };
    }

    const parsed = target ? parseTarget(target) : null;
    if (target && !parsed) {
      return {
        content: [
          {
            type: "text",
            text: 'target must be an address, optionally qualified: 0x…, 0x…::module, or 0x…::module::function',
          },
        ],
        isError: true,
      };
    }

    const fetcher = new TraceFetcher(network, true);
    try {
      const listed = await fetcher.listTransactions({
        startCheckpoint: BigInt(startCheckpoint),
        endCheckpoint: BigInt(endCheckpoint),
        limit: Math.min(Math.max(limit, 1), 500),
      });

      let inspected = 0;
      const matched: string[] = [];
      const inspectN = parsed && inspect > 0 ? Math.min(inspect, listed.transactions.length) : 0;

      for (const t of listed.transactions.slice(0, inspectN)) {
        try {
          const trace = await fetcher.fetch(t.digest);
          inspected++;
          if (parsed && traceTouchesTarget(trace, parsed.address, parsed.scope)) matched.push(t.digest);
        } catch {
          // A system transaction or an unreadable trace is still an inspected transaction: it was
          // asked, and it did not answer with the target.
          inspected++;
        }
      }

      const uninspected = listed.transactions.length - inspected;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                range: [startCheckpoint, endCheckpoint],
                network,
                count: listed.transactions.length,
                complete: listed.complete,
                endReason: listed.endReason,
                note: listed.complete
                  ? "range walked to its checkpoint bound"
                  : "truncated before the bound: narrow the range or raise limit",
                target: target ?? null,
                inspected,
                matched,
                matchedCount: matched.length,
                uninspected,
                presenceClaim: !target
                  ? "no target given, so this is a listing and not a claim about any package"
                  : inspectN === 0
                    ? "NOT CHECKED: target given with inspect=0, so no presence claim is made"
                    : matched.length > 0
                      ? `target present: ${matched.length} of ${inspected} inspected${uninspected > 0 ? `; ${uninspected} more were not inspected` : ""}`
                      : `no match in ${inspected} inspected${
                          uninspected > 0
                            ? `; ${uninspected} transactions were NOT inspected, so absence here is not absence in the range`
                            : "; the whole listing was inspected"
                        }`,
                transactions: listed.transactions.map((t) => ({
                  digest: t.digest,
                  checkpoint: t.checkpoint?.toString() ?? null,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error listing transactions: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "chase_hunt",
  "Run the agentic scout end to end: it lists transactions in scope, analyzes them, scores findings through triage, escalates anything at P0-P2 to the investigator, and decides when to stop under an explicit budget. Returns the report with coverage so the result can be checked. Use mode 'rules' for a deterministic no-network decision layer, 'real' for the configured LLM, 'stub' for testing.",
  {
    target: z
      .string()
      .optional()
      .describe("Package id (0x followed by 64 hex chars) to sweep checkpoints for, or a substring matched against violation evidence. Required unless `txs` is given"),
    txs: z
      .array(digestSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Explicit digest list to scan instead of sweeping checkpoints, which is the post-incident form of the question: these transactions, tier them, escalate anything at P0 to P2. One pass, no listing, and the report says no checkpoint range was read"
      ),
    goal: z.string().default("detect any suspicious activity"),
    checkpoints: z.number().int().min(1).max(500).default(20).describe("Checkpoints covered per scan pass"),
    passes: z.number().int().min(1).max(10).default(3).describe("Maximum scan passes before the scout stops"),
    mode: z.enum(["rules", "real", "stub"]).default("rules"),
    network: z.enum(["mainnet", "testnet", "devnet"]).default("mainnet"),
    maxRpcCalls: z.number().int().min(1).max(5000).default(200),
    maxLlmCalls: z.number().int().min(1).max(50).default(10),
    maxWallMs: z.number().int().min(5000).max(600000).default(180000),
    maxLlmTokens: z.number().int().min(1000).max(1000000).default(50000),
    reserveForJudge: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "RPC calls held back from the scan so a run that spends everything on listing still has enough left to triage and investigate what it already found"
      ),
  },
  async ({ target, txs, goal, checkpoints, passes, mode, network, maxRpcCalls, maxLlmCalls, maxWallMs, maxLlmTokens, reserveForJudge }) => {
    if (!target && !txs) {
      return {
        content: [
          {
            type: "text",
            text: "one of target or txs is required: name a package to sweep, or hand it the transactions to read",
          },
        ],
        isError: true,
      };
    }

    const llm =
      mode === "real" ? new RealLLM() : mode === "stub" ? new StubLLM() : new RuleBasedLLM();

    try {
      const mandate = validateMandate({
        target: target ?? `explicit:${txs!.length} tx(s)`,
        goal,
        checkpoints,
        budget: {
          maxRpcCalls,
          maxLlmCalls,
          maxLlmTokens,
          maxWallMs,
          reserveForJudge,
        },
        txs,
      });

      const report = await scout(mandate, llm, { network, maxIterations: passes });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                target: mandate.target,
                txs: mandate.txs?.length ?? null,
                mode,
                network,
                coverage: report.coverage,
                usage: report.usage,
                decisions: report.decisions,
                findingCount: report.findings.length,
                findings: report.findings,
                summary: report.summary,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Hunt failed: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
