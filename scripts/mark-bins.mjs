import fs from "node:fs";
import path from "node:path";

/**
 * tsc emits JavaScript, not executables. Every bin target in package.json already carries a
 * `#!/usr/bin/env node` line, but the file mode stays 0644, and npm packs the mode it finds. A
 * global install hides this because npm sets the bit on the symlink it creates, while `npx
 * @scope/pkg ...` execs the file straight out of the cache and the shell answers "Permission
 * denied". So the build marks the bins executable and a test asserts the modes, because a broken
 * quickstart line is indistinguishable from a broken tool to the person reading it.
 */
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const targets = Object.values(pkg.bin ?? {});

let marked = 0;
for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`[chase] bin target missing after build: ${rel}`);
    process.exit(1);
  }
  fs.chmodSync(file, 0o755);
  marked++;
}

console.log(`[chase] marked ${marked} bin target(s) executable`);
