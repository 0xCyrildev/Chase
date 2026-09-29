#!/usr/bin/env node
import "../lib/undici-setup.js";
import { Command } from "commander";
import { VERSION } from "../lib/version.js";
import { registerHunt } from "./command.js";

const program = new Command();
program.name("chase-hunt").version(VERSION);
registerHunt(program).parseAsync(process.argv);
