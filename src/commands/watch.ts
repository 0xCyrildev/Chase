import { TraceFetcher, NonProgrammableTransaction } from "../lib/fetcher.js";
import { runAnalysis, resolveNetwork, Network } from "./analyze.js";
import { cursorPath, loadCursor, saveCursor, resolveWatchStart, CursorNetwork } from "../lib/cursor.js";

/**
 * Injectable so the loop can be driven offline against committed fixtures. `chase watch` had no
 * automated coverage at all before this: its fixture path needs checkpoint listings, not just
 * traces, and a live listing cannot be committed. What the fake proves is the loop's bookkeeping —
 * which checkpoint the cursor advanced past, and what a failed listing did to the gap ledger.
 */
export interface WatchDeps {
  fetcher?: {
    getCheckpointHeight(): Promise<{ current: bigint; lowest: bigint }>;
    getCheckpointTransactions(seq: bigint): Promise<string[]>;
    close?(): Promise<void>;
  };
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WatchOptions {
  from?: string;
  filter?: string;
  limit?: string;
  network?: Network;
}

export async function watchCommand(opts: WatchOptions, deps: WatchDeps = {}) {
  const network = resolveNetwork(opts.network);
  const fetcher = deps.fetcher ?? new TraceFetcher(network, true);
  const sleep = deps.sleep ?? wait;
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

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

  const { current, lowest } = await fetcher.getCheckpointHeight();

  let flag: bigint | undefined;
  if (opts.from !== undefined) {
    if (!/^\d+$/.test(opts.from.trim())) {
      console.error(`[chase] --from must be a checkpoint number, got: ${opts.from}`);
      exit(2);
      return;
    }
    flag = BigInt(opts.from.trim());
    if (lowest > 0n && flag < lowest) {
      console.error(
        `[chase] --from ${flag} is below this endpoint's retention floor (${lowest}); ` +
          `those checkpoints would silently yield nothing. Start at ${lowest} or use the archive endpoint.`
      );
      exit(2);
      return;
    }
  }

  const start = resolveWatchStart({
    flag,
    saved: loadCursor(network as CursorNetwork),
    current,
    lowest,
    path: cursorPath(),
  });
  let cursor = start.cursor;
  const gaps = [...start.gaps];

  console.error(`[chase] ${start.why}`);
  if (gaps.length) {
    console.error(
      `[chase] ${gaps.length} checkpoint(s) from earlier runs were unreadable and are recorded as gaps, not covered`
    );
  }
  if (start.exitCode !== undefined) {
    console.error(`[chase] ${start.remedy}`);
    exit(start.exitCode);
    return;
  }
  console.error(`[chase] watching ${network} from checkpoint ${cursor} (tip=${current}, lowest=${lowest})`);

  let processed = 0;
  const unreadable: string[] = [];
  const empty: string[] = [];
  let totalChecked = 0;
  let totalFlagged = 0;

  const net = network as CursorNetwork;
  const cursorState = () => {
    if (!cursorPath()) return "not saved (cursor disabled by CHASE_WATCH_CURSOR_FILE='')";
    const at = loadCursor(net);
    return at ? `saved at ${at.checkpoint}${at.gaps.length ? `, ${at.gaps.length} gap(s)` : ""}` : "not saved";
  };

  // The stored position is the NEXT checkpoint to attempt, which is the same statement as "every
  // checkpoint before this one had its transactions attempted" plus the gaps recorded beside it.
  const persist = () => saveCursor(net, cursor, gaps);

  const summary = (how: string) =>
    console.error(
      `[chase] ${how}: ${processed} checkpoint(s), ${totalFlagged}/${totalChecked} transactions flagged` +
        (unreadable.length ? `, ${unreadable.length} checkpoint(s) UNREADABLE [${unreadable.join(", ")}]` : "") +
        (empty.length ? `, ${empty.length} empty` : "") +
        ` — cursor ${cursorState()}`
    );

  process.on("SIGINT", () => {
    // Nothing extra to write: the position is already the last completed boundary. But Ctrl-C used
    // to produce no closing line at all, which is how a monitor lies about its own uptime.
    summary("interrupted");
    process.exit(130);
  });

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
      gaps.push(cursor.toString());
      cursor++;
      processed++;
      // Advancing without recording it would turn an unreadable checkpoint into coverage the run
      // never had. The gap travels with the cursor.
      persist();
      continue;
    }

    if (digests.length === 0) {
      empty.push(cursor.toString());
      console.error(`[chase] checkpoint ${cursor}: 0 txs (empty or not yet indexed)`);
      if (cursor >= current) {
        await sleep(2000);
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
        await sleep(2000);
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
    persist();
  }

  summary("watched");

  if (unreadable.length > 0) {
    console.error("[chase] coverage was incomplete, so this run did not survey the whole range");
    exit(2);
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
