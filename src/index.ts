#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { analyzeCommand } from "./commands/analyze.js";
import { printBanner } from "./lib/banner.js";

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
  .action(async (digest, opts) => {
    if (!opts.json) printBanner();
    try {
      await analyzeCommand(digest, opts);
    } catch (err) {
      console.error("[chase] error:", err);
      process.exit(2);
    }
  });

program.parseAsync(process.argv);
