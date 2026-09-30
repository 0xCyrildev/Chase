import { TraceFetcher, NonProgrammableTransaction } from "../lib/fetcher.js";
import { runAnalysis, resolveNetwork, Network } from "./analyze.js";
import {
  CursorNetwork,
  clearCursor,
  cursorPath,
  cursorStatus,
  loadCursor,
  saveCursor,
  resolveWatchStart,
} from "../lib/cursor.js";

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
  /** Last checkpoint to read, inclusive. Without it the run watches until interrupted. */
  to?: string;
  filter?: string;
  limit?: string;
  network?: Network;
  /** Report the stored position and leave. Makes no network call. */
  status?: boolean;
  /** Forget the stored position for this network and leave. */
  resetCursor?: boolean;
}

export async function watchCommand(opts: WatchOptions, deps: WatchDeps = {}) {
  const network = resolveNetwork(opts.network);
  const net = network as CursorNetwork;
  const sleep = deps.sleep ?? wait;
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

  if (opts.status && opts.resetCursor) {
    console.error(
      `[chase] --status and --reset-cursor together is one question and one deletion. Ask them ` +
        `separately, so you can see what was there before you removed it.`
    );
    exit(2);
    return;
  }

  if (opts.status || opts.resetCursor) {
    // Nothing here opens a socket: a question about local state that answers itself must not fail
    // because the endpoint is down, and must not be billed as a scan.
    const asked = opts.status ? "--status" : "--reset-cursor";
    if (opts.status) {
      reportCursor(net);
    } else {
      const code = resetCursor(net);
      if (code !== 0) {
        exit(code);
        return;
      }
    }
    const ignored = ["from", "to", "filter", "limit"].filter((f) => (opts as any)[f] !== undefined);
    console.error(`[chase] no scan ran (${asked})`);
    if (ignored.length) {
      console.error(
        `[chase] ${ignored.map((f) => `--${f}`).join(" ")} were ignored: ${asked} reads local state and scans nothing`
      );
    }
    return;
  }

  let limit: number;
  if (opts.limit === undefined) {
    limit = Infinity;
  } else {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`[chase] --limit must be a positive whole number, got: ${opts.limit}`);
      exit(2);
      return;
    }
  }

  let bound: bigint | undefined;
  if (opts.to !== undefined) {
    if (!/^\d+$/.test(opts.to.trim())) {
      console.error(`[chase] --to must be a checkpoint number, got: ${opts.to}`);
      exit(2);
      return;
    }
    bound = BigInt(opts.to.trim());
  }

  let flag: bigint | undefined;
  if (opts.from !== undefined) {
    if (!/^\d+$/.test(opts.from.trim())) {
      console.error(`[chase] --from must be a checkpoint number, got: ${opts.from}`);
      exit(2);
      return;
    }
    flag = BigInt(opts.from.trim());
  }

  const fetcher = deps.fetcher ?? new TraceFetcher(network, true);

  const { current, lowest } = await fetcher.getCheckpointHeight();
  let tip = current;

  if (flag !== undefined && lowest > 0n && flag < lowest) {
    console.error(
      `[chase] --from ${flag} is below this endpoint's retention floor (${lowest}); ` +
        `those checkpoints would silently yield nothing. Start at ${lowest} or use the archive endpoint.`
    );
    exit(2);
    return;
  }

  if (bound !== undefined && lowest > 0n && bound < lowest) {
    console.error(
      `[chase] --to ${bound} is below this endpoint's retention floor (${lowest}), so the whole range ` +
        `would yield nothing. Point SUI_ARCHIVE_URL at a node that still has it.`
    );
    exit(2);
    return;
  }

  const start = resolveWatchStart({
    flag,
    saved: loadCursor(net),
    current: tip,
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

  // A range that ends before it starts is a run that scans nothing and prints a summary as though
  // it had. Refuse rather than produce an empty report with a clean coverage line.
  if (bound !== undefined && bound < cursor) {
    console.error(
      `[chase] --to ${bound} is before ${cursor}, the first checkpoint this run would read, so nothing ` +
        `would be scanned. Widen the range, or pass --from <checkpoint> to name the range you mean.`
    );
    exit(2);
    return;
  }

  console.error(
    `[chase] watching ${network} from checkpoint ${cursor}${bound !== undefined ? ` to ${bound}` : ""} (tip=${tip}, lowest=${lowest})`
  );

  let processed = 0;
  const unreadable: string[] = [];
  const empty: string[] = [];
  let totalChecked = 0;
  let totalFlagged = 0;
  /** A sentence explaining why the requested range was not delivered, when it was not. */
  let stoppedBeforeBound: string | undefined;

  const cursorState = () => {
    if (!cursorPath()) return "not saved (cursor disabled by CHASE_WATCH_CURSOR_FILE='')";
    const at = loadCursor(net);
    return at ? `saved at ${at.checkpoint}${at.gaps.length ? `, ${at.gaps.length} gap(s)` : ""}` : "not saved";
  };

  // The stored position is the NEXT checkpoint to attempt, which is the same statement as "every
  // checkpoint before this one had its transactions attempted" plus the gaps recorded beside it.
  let persisted = false;
  const persist = () => {
    persisted = true;
    saveCursor(net, cursor, gaps);
  };

  const summary = (how: string) =>
    console.error(
      `[chase] ${how}: ${processed} checkpoint(s), ${totalFlagged}/${totalChecked} transactions flagged` +
        (unreadable.length ? `, ${unreadable.length} checkpoint(s) UNREADABLE [${unreadable.join(", ")}]` : "") +
        (empty.length ? `, ${empty.length} empty` : "") +
        `, cursor ${cursorState()}`
    );

  process.on("SIGINT", () => {
    // Nothing extra to write: the position is already the last completed boundary. But Ctrl-C used
    // to produce no closing line at all, which is how a monitor lies about its own uptime.
    summary("interrupted");
    process.exit(130);
  });

  while (processed < limit && (bound === undefined || cursor <= bound)) {
    if (bound !== undefined && cursor > tip) {
      // The chain may have caught up while this run worked. Re-check the tip rather than walking
      // through checkpoints that do not exist yet and recording them as attempted: an advance past
      // a nonexistent range reads as coverage the endpoint never had.
      try {
        tip = (await fetcher.getCheckpointHeight()).current;
      } catch (err: any) {
        stoppedBeforeBound =
          `--to ${bound} was not reached and the tip could not be re-checked ` +
          `(${String(err?.message ?? err).slice(0, 120)}), so the run stopped at ${cursor} rather ` +
          `than guessing at what exists above it`;
        break;
      }
      if (cursor > tip) {
        stoppedBeforeBound =
          `--to ${bound} was not reached: this endpoint's tip is ${tip}, so ${cursor}..${bound} ` +
          `do not exist yet and were not scanned`;
        break;
      }
    }

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
      if (cursor >= tip) {
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

  summary(
    stoppedBeforeBound !== undefined
      ? "watched as far as this endpoint has data"
      : bound !== undefined
        ? "watched the requested range"
        : "watched"
  );

  // Two different reasons a range ends early, and they want different answers. `--limit` is a stop
  // the operator asked for, so the run did what it was told and exits clean. Not reaching `--to`
  // because the chain is not there yet is a range that was asked for and not delivered.
  if (bound !== undefined && stoppedBeforeBound === undefined && cursor <= bound) {
    console.error(
      `[chase] --limit stopped the run at ${cursor}; --to ${bound} was not reached, and the cursor is ` +
        `saved there so the next run continues from it`
    );
  }

  const incomplete: string[] = [];
  if (stoppedBeforeBound) incomplete.push(stoppedBeforeBound);
  if (unreadable.length > 0) {
    incomplete.push(`${unreadable.length} checkpoint(s) could not be read [${unreadable.join(", ")}]`);
  }
  for (const line of incomplete) {
    console.error(`[chase] coverage was incomplete: ${line}`);
  }
  if (incomplete.length > 0) {
    console.error(
      persisted
        ? `[chase] so this run did not survey the whole range, and the position is saved at ${cursor}, ` +
            `which is where a re-run picks up`
        : `[chase] so this run did not survey the whole range, and it saved no position either: the ` +
            `checkpoints from ${cursor} upward are still unclaimed. A re-run with the same --from starts here.`
    );
    exit(2);
  }
}

function reportCursor(network: CursorNetwork) {
  const s = cursorStatus(network);
  console.error(`[chase] watch position on ${network}`);
  if (s.state === "disabled") {
    console.error(
      `[chase]   no cursor file: CHASE_WATCH_CURSOR_FILE is set to the empty string, so nothing is remembered`
    );
    console.error(`[chase]   every run starts at tip-2, and a restart re-reads the last two checkpoints`);
    return;
  }
  console.error(`[chase]   file: ${s.path}`);
  if (s.state === "absent") {
    console.error(`[chase]   nothing saved for ${network}; the next run starts at tip-2`);
    return;
  }
  if (s.state === "unreadable" || !s.entry) {
    console.error(`[chase]   the stored ${network} record could not be used: ${s.detail}`);
    console.error(
      `[chase]   reset it on purpose with: chase watch --reset-cursor -n ${network} ` +
        `(that drops the position and starts from tip-2), or --from <checkpoint> to name where to resume`
    );
    return;
  }
  console.error(
    `[chase]   next checkpoint to attempt: ${s.entry.checkpoint} (saved ${s.entry.savedAt})`
  );
  console.error(
    `[chase]   every checkpoint below it was attempted${
      s.entry.gaps.length ? `, and ${s.entry.gaps.length} of them could not be read` : ", with no recorded gaps"
    }${s.entry.gaps.length ? `: ${s.entry.gaps.slice(0, 12).join(", ")}${s.entry.gaps.length > 12 ? " …" : ""}` : ""}`
  );
  console.error(`[chase]   to forget it: chase watch --reset-cursor -n ${network}`);
}

/** Returns the exit code the command should leave with: 0 when the reset happened or nothing asked for it. */
function resetCursor(network: CursorNetwork): number {
  const r = clearCursor(network);
  if (r.path === null) {
    console.error(
      `[chase] nothing to reset: CHASE_WATCH_CURSOR_FILE is the empty string, so no position is kept anyway`
    );
    return 0;
  }
  if (!r.removed) {
    if (r.entry === null && r.detail === undefined) {
      console.error(`[chase] nothing saved for ${network} at ${r.path}, so there was nothing to reset`);
      return 0;
    }
    // Never report a reset that did not happen. The file stays exactly as it was.
    console.error(
      `[chase] could not reset the ${network} position (${r.path}): ${r.detail}. ` +
        `Nothing was deleted; the file still holds what it held before.`
    );
    return 2;
  }
  if (r.entry === null) {
    console.error(`[chase] removed an unreadable stored record for ${network} from ${r.path}`);
    return 0;
  }
  console.error(
    `[chase] forgot the ${network} position (was ${r.entry.checkpoint}, saved ${r.entry.savedAt}` +
      `${r.entry.gaps.length ? `, with ${r.entry.gaps.length} recorded gap(s)` : ""})`
  );
  console.error(
    `[chase] the next run starts at tip-2, so everything above ${r.entry.checkpoint} is now ` +
      `unclaimed. To go back for it on purpose: chase watch --from ${BigInt(r.entry.checkpoint)}`
  );
  return 0;
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
