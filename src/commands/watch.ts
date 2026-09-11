import { TraceFetcher } from "../lib/fetcher.js";
import { runAnalysis } from "./analyze.js";

interface WatchOptions {
  from?: string;
  filter?: string;
  limit?: string;
}

export async function watchCommand(opts: WatchOptions) {
  const fetcher = new TraceFetcher();
  const limit = opts.limit ? parseInt(opts.limit, 10) : Infinity;

  let cursor: bigint;
  if (opts.from) {
    cursor = BigInt(opts.from);
  } else {
    const { current, lowest } = await fetcher.getCheckpointHeight();
    cursor = current - 2n;
    console.error(`[chase] tip=${current} lowest=${lowest} starting=${cursor}`);
  }

  console.error(`[chase] watching from checkpoint ${cursor}`);

  let processed = 0;
  while (processed < limit) {
    let digests: string[] = [];
    try {
      digests = await fetcher.getCheckpointTransactions(cursor);
    } catch (err: any) {
      console.error(`[chase] checkpoint ${cursor} fetch failed: ${err?.message ?? err}`);
      cursor++;
      processed++;
      continue;
    }

    console.error(`[chase] checkpoint ${cursor}: ${digests.length} txs`);

    let checked = 0;
    let flagged = 0;

    for (const digest of digests) {
      checked++;
      if (checked % 50 === 0) {
        console.error(`[chase] … ${checked}/${digests.length} (${flagged} flagged)`);
      }

      const report = await tryAnalyze(digest, opts.filter);
      if (report === null) {
        // Not-yet-indexed tx — retry once after a short delay
        await new Promise((r) => setTimeout(r, 2000));
        const retried = await tryAnalyze(digest, opts.filter, true);
        if (retried && retried.violations.length > 0) {
          flagged++;
          console.log(
            JSON.stringify({
              digest,
              checkpoint: cursor.toString(),
              violations: retried.violations,
            })
          );
        }
        continue;
      }

      if (report.violations.length > 0) {
        flagged++;
        console.log(
          JSON.stringify({
            digest,
            checkpoint: cursor.toString(),
            violations: report.violations,
          })
        );
      }
    }

    console.error(`[chase] checkpoint ${cursor} done: ${flagged}/${checked} flagged`);
    cursor++;
    processed++;
  }
}

interface WatchViolation {
  type: string;
  severity: string;
  message?: string;
  module?: string;
  count?: number;
}

/**
 * Attempts analysis. Returns:
 * - report on success (violations array may be empty)
 * - null if the tx was not found (caller should retry) or is a non-PTB system tx
 * On unexpected errors, logs and returns null.
 */
async function tryAnalyze(
  digest: string,
  filter: string | undefined,
  silent = false
): Promise<{ violations: WatchViolation[] } | null> {
  try {
    const report = await runAnalysis(digest, false);

    if (filter) {
      const touches = report.violations.some((v) =>
        JSON.stringify(v.evidence ?? {}).includes(filter)
      );
      if (!touches) return { violations: [] };
    }

    return {
      violations: report.violations.map((v) => ({
        type: v.type,
        severity: v.severity,
        message: v.message,
        module: (v.evidence as any)?.module,
        count: (v.evidence as any)?.count,
      })),
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);

    if (msg.includes("Only programmable transactions")) {
      return null;
    }

    if (msg.includes("not found") || msg.includes("notFound")) {
      if (!silent) console.error(`[chase] ${digest.slice(0, 16)}… not indexed yet, retrying`);
      return null;
    }

    if (!silent) console.error(`[chase] ${digest.slice(0, 16)}… error: ${msg}`);
    return null;
  }
}
