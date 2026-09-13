import { TraceFetcher } from "../lib/fetcher.js";
import { runAnalysis, Network } from "./analyze.js";

interface WatchOptions {
  from?: string;
  filter?: string;
  limit?: string;
  network?: Network;
}

export async function watchCommand(opts: WatchOptions) {
  const network: Network = opts.network ?? "mainnet";
  const fetcher = new TraceFetcher(network, true);
  const limit = opts.limit ? parseInt(opts.limit, 10) : Infinity;

  let cursor: bigint;
  if (opts.from) {
    cursor = BigInt(opts.from);
  } else {
    const { current, lowest } = await fetcher.getCheckpointHeight();
    cursor = current - 2n;
    console.error(`[chase] tip=${current} lowest=${lowest} starting=${cursor}`);
  }

  console.error(`[chase] watching ${network} from checkpoint ${cursor}`);

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

      const report = await tryAnalyze(digest, opts.filter, network);
      if (report === null) {
        await new Promise((r) => setTimeout(r, 2000));
        const retried = await tryAnalyze(digest, opts.filter, network, true);
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

async function tryAnalyze(
  digest: string,
  filter: string | undefined,
  network: Network,
  silent = false
): Promise<{ violations: WatchViolation[] } | null> {
  try {
    const report = await runAnalysis(digest, false, true, network);

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
