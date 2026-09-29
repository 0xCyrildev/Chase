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
import { triage } from "./triage/index.js";
import { scout } from "./agent/scout.js";
import { validateMandate } from "./agent/mandate.js";
import { RealLLM } from "./agent/llm.js";
import { StubLLM } from "./agent/stub-llm.js";
import { RuleBasedLLM } from "./agent/rules-llm.js";
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
  },
  async ({ digest, network, debug }) => {
    try {
      const report = await runAnalysis(digest, debug, true, network);
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
  "Query Chase's local cache. Returns how many Move function signatures are cached and the cache directory path.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              signatures_cached: signatureCacheSize(),
              cache_dir: cacheDir(),
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
  "Scan a range of Sui checkpoints, running invariants on each transaction. Returns any findings. Bounded to a small range to keep the call responsive.",
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
  },
  async ({ digests, network, minTier }) => {
    try {
      const report = await triage(digests, {
        network,
        minTier: minTier as any,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                digests: report.digests,
                summary: report.summary,
                findings: report.findings.map((f) => ({
                  digest: f.digest,
                  type: f.violation.type,
                  severity: f.violation.severity,
                  tier: f.tier,
                  score: f.score,
                  message: f.violation.message,
                  rationale: f.rationale,
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

server.tool(
  "chase_list",
  "List transactions in a checkpoint range, optionally filtered SERVER-SIDE by a MoveCall target. One or two RPC calls, no per-transaction fetch, so use this before analyzing anything to learn what is actually in a range. The moveCall argument is a dotted-prefix match: a bare package id matches any call into that package, " +
    "'pkg::module' narrows to a module, and a full 'pkg::module::function' narrows further. Only top-level PTB commands are indexed, so a package reached solely through another package's internal calls will not appear.",
  {
    startCheckpoint: z.number().int().nonnegative().describe("First checkpoint sequence number (inclusive)"),
    endCheckpoint: z.number().int().nonnegative().describe("Last checkpoint sequence number (inclusive); at most 500 wide"),
    moveCall: z
      .string()
      .optional()
      .describe("Package id, pkg::module, or pkg::module::function to filter by"),
    network: z.enum(["mainnet", "testnet", "devnet"]).default("mainnet"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max digests to return"),
  },
  async ({ startCheckpoint, endCheckpoint, moveCall, network, limit }) => {
    if (endCheckpoint < startCheckpoint) {
      return {
        content: [{ type: "text", text: "endCheckpoint must be >= startCheckpoint" }],
        isError: true,
      };
    }

    const fetcher = new TraceFetcher(network, true);
    try {
      const listed = await fetcher.listTransactions({
        startCheckpoint: BigInt(startCheckpoint),
        endCheckpoint: BigInt(endCheckpoint),
        moveCallFunction: moveCall,
        limit: Math.min(Math.max(limit, 1), 500),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                range: [startCheckpoint, endCheckpoint],
                network,
                filter: moveCall ?? null,
                count: listed.transactions.length,
                complete: listed.complete,
                endReason: listed.endReason,
                note: listed.complete
                  ? "range walked to its checkpoint bound"
                  : "truncated before the bound: narrow the range or raise limit",
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
      .describe("Package id (0x followed by 64 hex chars) for server-side filtering, or a substring matched against violation evidence"),
    goal: z.string().default("detect any suspicious activity"),
    checkpoints: z.number().int().min(1).max(500).default(20).describe("Checkpoints covered per scan pass"),
    passes: z.number().int().min(1).max(10).default(3).describe("Maximum scan passes before the scout stops"),
    mode: z.enum(["rules", "real", "stub"]).default("rules"),
    network: z.enum(["mainnet", "testnet", "devnet"]).default("mainnet"),
    maxRpcCalls: z.number().int().min(1).max(5000).default(200),
    maxLlmCalls: z.number().int().min(1).max(50).default(10),
    maxWallMs: z.number().int().min(5000).max(600000).default(180000),
    maxLlmTokens: z.number().int().min(1000).max(1000000).default(50000),
  },
  async ({ target, goal, checkpoints, passes, mode, network, maxRpcCalls, maxLlmCalls, maxWallMs, maxLlmTokens }) => {
    if (!target) {
      return { content: [{ type: "text", text: "target is required" }], isError: true };
    }

    const llm =
      mode === "real" ? new RealLLM() : mode === "stub" ? new StubLLM() : new RuleBasedLLM();

    try {
      const mandate = validateMandate({
        target,
        goal,
        checkpoints,
        budget: {
          maxRpcCalls,
          maxLlmCalls,
          maxLlmTokens,
          maxWallMs,
        },
      });

      const report = await scout(mandate, llm, { network, maxIterations: passes });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                target,
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
