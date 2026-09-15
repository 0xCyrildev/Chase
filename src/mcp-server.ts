#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAnalysis } from "./commands/analyze.js";
import { TraceFetcher } from "./lib/fetcher.js";
import { signatureCacheSize } from "./lib/sigcache.js";
import { triage } from "./triage/index.js";

const server = new McpServer({
  name: "chase",
  version: "0.1.0",
});

server.tool(
  "chase_analyze",
  "Analyze a Sui Move transaction by digest. Fetches the execution trace over gRPC and runs invariant checks (mutable-access, oracle-pattern, ownership-anomaly, reentrancy-pattern, etc). Returns violations with severity and evidence.",
  {
    digest: z.string().describe("Transaction digest (base58, e.g. 5RHbYgCHr...)"),
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
              cache_dir: process.env.CHASE_CACHE_DIR ?? "~/.cache/chase",
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
    from: z.number().describe("Starting checkpoint sequence number (inclusive)"),
    to: z.number().describe("Ending checkpoint sequence number (inclusive). Keep range small (<= 5)."),
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
    const fetcher = new TraceFetcher(network, true);
    const findings: any[] = [];

    for (let seq = BigInt(from); seq <= BigInt(to); seq++) {
      let digests: string[] = [];
      try {
        digests = await fetcher.getCheckpointTransactions(seq);
      } catch (err: any) {
        findings.push({ checkpoint: seq.toString(), error: err?.message ?? String(err) });
        continue;
      }

      for (const digest of digests) {
        try {
          const report = await runAnalysis(digest, false, true, network);
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
        } catch {
          // skip system txs and indexing lag
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ from, to, network, findings }, null, 2),
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
      .array(z.string())
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

const transport = new StdioServerTransport();
await server.connect(transport);
