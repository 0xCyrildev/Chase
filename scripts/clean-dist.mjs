import fs from "node:fs";
import path from "node:path";

/**
 * tsc only writes files; it never removes them. Without this step a module deleted from `src`
 * keeps living in `dist` as compiled JavaScript, and `files` ships all of `dist` — so a published
 * build would carry code the source tree no longer contains.
 */
const dist = path.resolve(import.meta.dirname, "../dist");
fs.rmSync(dist, { recursive: true, force: true });
console.log("[chase] removed stale dist/ before compiling");
