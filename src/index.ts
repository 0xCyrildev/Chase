#!/usr/bin/env node
import "./lib/undici-setup.js";
import { Command } from "commander";
import dotenv from "dotenv";
import { analyzeCommand } from "./commands/analyze.js";
import { batchCommand } from "./commands/batch.js";
import { watchCommand } from "./commands/watch.js";
import { printBanner } from "./lib/banner.js";
import { VERSION } from "./lib/version.js";
import { clearCache, cacheDir } from "./lib/cache.js";
import { clearSignatureCache, signatureCacheSize } from "./lib/sigcache.js";
import { registerTriage } from "./triage/command.js";
import { registerHunt } from "./agent/command.js";
import { reportError } from "./lib/error.js";

dotenv.config({ quiet: true });

const program = new Command();

program
  .name("chase")
  .description("Chase — dynamic analysis tool for Sui Move transactions")
  .version(VERSION);

program
  .command("analyze <digest>")
  .description("Analyze a Sui transaction by digest")
  .option("--json", "Output as JSON")
  .option("-o, --out <file>", "Write report to file")
  .option("--debug", "Print resolved commands, balance changes, and events to stderr")
  .option("--no-cache", "Bypass the on-disk trace cache")
  .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet); defaults to $SUI_NETWORK, then mainnet")
  .action(async (digest, opts) => {
    if (!opts.json) printBanner();
    try {
      await analyzeCommand(digest, opts);
    } catch (err) {
      reportError("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("batch <file>")
  .description("Analyze multiple digests from a file (one per line, # for comments)")
  .option("-o, --out <file>", "Write NDJSON results to file")
  .option("-c, --concurrency <n>", "Parallel fetch limit (default 5, max 20)")
  .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet); defaults to $SUI_NETWORK, then mainnet")
  .action(async (file, opts) => {
    printBanner();
    try {
      await batchCommand(file, opts);
    } catch (err) {
      reportError("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("watch")
  .description("Scan new checkpoints, running invariants on each transaction (resumes from the last one it finished)")
  .option("--from <seq>", "Start at this checkpoint; does not rewind the saved cursor (set CHASE_WATCH_CURSOR_FILE='' to disable saving)")
  .option("--filter <substring>", "Only report findings whose evidence matches this substring")
  .option("--limit <n>", "Stop after processing N checkpoints")
  .option("-n, --network <net>", "Sui network (mainnet, testnet, devnet); defaults to $SUI_NETWORK, then mainnet")
  .action(async (opts) => {
    printBanner();
    try {
      await watchCommand(opts);
    } catch (err) {
      reportError("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("cache")
  .description("Manage the local trace cache")
  .option("--clear", "Delete all cached traces and signatures")
  .option("--dir", "Print the cache directory")
  .action((opts) => {
    if (opts.dir) {
      console.log(cacheDir());
      return;
    }
    if (opts.clear) {
      const c = clearCache();
      const s = clearSignatureCache();
      console.error(
        `[chase] removed ${c.traces} cached trace(s), ${s} cached signature(s)`
      );
      if (c.unreachableTraces > 0 || c.checkpoints > 0) {
        console.error(
          `[chase] also removed ${c.unreachableTraces} trace file(s) left over from before traces were ` +
            `namespaced by network and ${c.checkpoints} checkpoint listing(s) — these were unreadable ` +
            `and had survived --clear until now`
        );
      }
      return;
    }
    console.error(`[chase] cache dir: ${cacheDir()}`);
    console.error(`[chase] signatures cached: ${signatureCacheSize()}`);
    console.error(`[chase] use --clear to wipe, --dir to print path`);
  });

program.addCommand(registerTriage(new Command("triage")));
program.addCommand(registerHunt(new Command("hunt")));

program.parseAsync(process.argv);
