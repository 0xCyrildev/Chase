import fs from "node:fs";
import path from "node:path";

/**
 * Read the version from package.json instead of restating it. A `--version` that drifts from the
 * published version is a number people paste into reports, and the copy nobody remembers to bump is
 * always the duplicate. Two levels up resolves for both `src/lib` and `dist/lib`, and the npm tarball
 * ships package.json at its root.
 */
function readVersion(): string {
  try {
    const file = path.resolve(import.meta.dirname, "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const VERSION = readVersion();
