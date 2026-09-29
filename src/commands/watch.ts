import { TraceFetcher, NonProgrammableTransaction } from "../lib/fetcher.js";
import { runAnalysis, resolveNetwork, Network } from "./analyze.js";

interface WatchOptions {
  from?: string;
  filter?: string;
  limit?: string;
  network?: Network;
}

export async function watchCommand(opts: WatchOptions) {
  const network = resolveNetwork(opts.network);
  const fetcher = new TraceFetcher(network, true);

  let limit: number;
  if (opts.limit === undefined) {
    limit = Infinity;
  } else {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`[chase] --limit must be a positive whole number, got: ${opts.limit}`);
      process.exit(2);
    }
  }

  let cursor: bigint;
  const { current, lowest } = await fetcher.getCheckpointHeight();

  if (opts.from !== undefined) {
    if (!/^\d+$/.test(opts.from.trim())) {
      console.error(`[chase] --from must be a checkpoint number, got: ${opts.from}`);
      process.exit(2);
    }
    cursor = BigInt(opts.from.trim());
    if (lowest > 0n && cursor < lowest) {
      console.error(
        `[chase] --from ${cursor} is below this endpoint's retention floor (${lowest}); ` +
          `those checkpoints would silently yield nothing. Start at ${lowest} or use the archive endpoint.`
      );
      process.exit(2);
    }
  } else {
    cursor = current - 2n;
  }

  console.error(`[chase] watching ${network} from checkpoint ${cursor} (tip=${current}, lowest=${lowest})`);

  let processed = 0;
  const unreadable: string[] = [];
  const empty: string[] = [];
  let totalChecked = 0;
  let totalFlagged = 0;

  while (processed < limit) {
    let digests: string[] = [];
    try {
      digests = await fetcher.getCheckpointTransactions(cursor);
    } catch (err: any) {
      const code = err?.code ? `[${err.code}] ` : "";
      console.error(
        `[chase] checkpoint ${cursor} fetch failed: ${code}${err?.message || err?.name || "unknown error"}`
      );
      unreadable.push(cursor.toString());
      cursor++;
      processed++;
      continue;
    }

    if (digests.length === 0) {
      empty.push(cursor.toString());
      console.error(`[chase] checkpoint ${cursor}: 0 txs (empty or not yet indexed)`);
      if (cursor >= current) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } else {
      console.error(`[chase] checkpoint ${cursor}: ${digests.length} txs`);
    }

    let checked = 0;
    let flagged = 0;

    for (const digest of digests) {
      checked++;
      if (checked % 50 === 0) {
        console.error(`[chase] … ${checked}/${digests.length} (${flagged} flagged)`);
      }

      const report = await tryAnalyze(digest, opts.filter, network);
      if (report === undefined) continue;
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
    totalChecked += checked;
    totalFlagged += flagged;
    cursor++;
    processed++;
  }

  console.error(
    `[chase] watched ${processed} checkpoint(s): ${totalFlagged}/${totalChecked} transactions flagged` +
      (unreadable.length ? `, ${unreadable.length} checkpoint(s) UNREADABLE [${unreadable.join(", ")}]` : "") +
      (empty.length ? `, ${empty.length} empty` : "")
  );

  if (unreadable.length > 0) {
    console.error("[chase] coverage was incomplete, so this run did not survey the whole range");
    process.exit(2);
  }
}

interface WatchViolation {
  type: string;
  severity: string;
  message?: string;
  module?: string;
  count?: number;
}

// null means "worth one retry because the tx may not be indexed yet";
// undefined means a permanent skip, which must not cost a second fetch.
async function tryAnalyze(
  digest: string,
  filter: string | undefined,
  network: Network,
  silent = false
): Promise<{ violations: WatchViolation[] } | null | undefined> {
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
    if (err instanceof NonProgrammableTransaction) {
      return undefined;
    }

    const msg = err?.message ?? String(err);

    if (err?.reason === "notFound" || msg.includes("not found")) {
      if (!silent) console.error(`[chase] ${digest.slice(0, 16)}… not indexed yet, retrying`);
      return null;
    }

    if (!silent) console.error(`[chase] ${digest.slice(0, 16)}… error: ${msg}`);
    return undefined;
  }
}
