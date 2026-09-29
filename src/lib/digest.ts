/**
 * Digests arrive from command lines, JSON reports and agent tool calls, and they are used to
 * build cache file paths. Without a shape check a "digest" can walk out of the cache directory
 * and have any JSON file on disk analysed as if it were on-chain ground truth.
 */
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

export function assertDigest(value: unknown, label = "digest"): string {
  if (!isDigest(value)) {
    throw new Error(`${label} is not a valid Sui transaction digest: ${String(value).slice(0, 80)}`);
  }
  return value;
}
