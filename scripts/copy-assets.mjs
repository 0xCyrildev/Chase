import fs from "node:fs";
import path from "node:path";

/**
 * tsc emits only JavaScript, but the triage layer reads its config and benign-pattern library
 * from __dirname at runtime. Without this copy step a published build dies in scoring or
 * silently loses every suppression rule.
 */
const from = path.resolve(import.meta.dirname, "../src/triage");
const to = path.resolve(import.meta.dirname, "../dist/triage");

let copied = 0;
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith(".json")) continue;
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  copied++;
}

console.log(`[chase] copied ${copied} runtime asset(s) into dist/triage`);
