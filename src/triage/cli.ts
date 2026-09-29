#!/usr/bin/env node
import "../lib/undici-setup.js";
import { Command } from "commander";
import { VERSION } from "../lib/version.js";
import { registerTriage } from "./command.js";

const program = new Command();
program.name("chase-triage").version(VERSION);
registerTriage(program).parseAsync(process.argv);
