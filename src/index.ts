#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { analyzeCommand } from "./commands/analyze.js";
import { batchCommand } from "./commands/batch.js";
import { watchCommand } from "./commands/watch.js";
import { printBanner } from "./lib/banner.js";
import { clearCache, cacheDir } from "./lib/cache.js";

dotenv.config();

const program = new Command();

program
  .name("chase")
  .description("Chase — dynamic analysis tool for Sui Move transactions")
  .version("0.1.0");

program
  .command("analyze <digest>")
  .description("Analyze a Sui transaction by digest")
  .option("--json", "Output as JSON")
  .option("-o, --out <file>", "Write report to file")
  .option("--debug", "Print resolved commands, balance changes, and events to stderr")
  .option("--no-cache", "Bypass the on-disk trace cache")
  .action(async (digest, opts) => {
    if (!opts.json) printBanner();
    try {
      await analyzeCommand(digest, opts);
    } catch (err) {
      console.error("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("batch <file>")
  .description("Analyze multiple digests from a file (one per line, # for comments)")
  .option("-o, --out <file>", "Write NDJSON results to file")
  .action(async (file, opts) => {
    printBanner();
    try {
      await batchCommand(file, opts);
    } catch (err) {
      console.error("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("watch")
  .description("Scan new checkpoints, running invariants on each transaction")
  .option("--from <seq>", "Starting checkpoint sequence number")
  .option("--filter <substring>", "Only report findings whose evidence matches this substring")
  .option("--limit <n>", "Stop after processing N checkpoints")
  .action(async (opts) => {
    printBanner();
    try {
      await watchCommand(opts);
    } catch (err) {
      console.error("[chase] error:", err);
      process.exit(2);
    }
  });

program
  .command("cache")
  .description("Manage the local trace cache")
  .option("--clear", "Delete all cached traces")
  .option("--dir", "Print the cache directory")
  .action((opts) => {
    if (opts.dir) {
      console.log(cacheDir());
      return;
    }
    if (opts.clear) {
      const n = clearCache();
      console.error(`[chase] removed ${n} cached trace(s)`);
      return;
    }
    console.error(`[chase] cache dir: ${cacheDir()}`);
    console.error(`[chase] use --clear to wipe, --dir to print path`);
  });

program.parseAsync(process.argv);
