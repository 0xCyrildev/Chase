import { SuiTransactionTrace } from "./types.js";

/**
 * Canonical address comparison for target matching. Sui accepts short addresses, and the same package
 * is written both ways depending on where in a trace you look.
 */
export function normalizeAddress(target: string): string | null {
  const m = /^0x([0-9a-fA-F]{1,64})$/.exec(target.trim());
  if (!m) return null;
  return `0x${m[1].toLowerCase().padStart(64, "0")}`;
}

/** The package component of a Move type string, e.g. `0x2::coin::Coin<T>` -> `0x…02`. */
export function moveTypePackage(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const m = /^0x([0-9a-fA-F]{1,64})::/.exec(value.trim());
  return m ? `0x${m[1].toLowerCase().padStart(64, "0")}` : null;
}

/**
 * Did this transaction involve the target package?
 *
 * Three positions are checked, because one is never enough. A top-level MoveCall names the package the
 * sender called directly — which for routed volume is the router, not the protocol. An event's `packageId`
 * carries the *updated* package version. Only the type strings in event types and object types keep the
 * *original* package id, and that is the form a mandate or an audit report is written with.
 *
 * The gRPC `moveCall` listing filter is deliberately not used for this: measured on mainnet it answered
 * "nothing, complete=true" for `0x2::transfer`, and for a Cetus package id that 8% of the sampled
 * transactions demonstrably swapped through. A filter that reports a busy protocol as quiet turns a
 * sampling failure into a clean-scan claim.
 */
export interface TargetMatch {
  module?: string;
  function?: string;
}

export function traceTouchesTarget(
  trace: SuiTransactionTrace,
  target: string,
  scope: TargetMatch = {}
): boolean {
  const packageMatches = (value: string | undefined): boolean =>
    normalizeAddress(value ?? "") === target;

  for (const cmd of trace.ptbCommands ?? []) {
    if (!packageMatches(cmd.packageId)) continue;
    if (scope.module && cmd.module !== scope.module) continue;
    if (scope.function && !String(cmd.function ?? "").startsWith(scope.function)) continue;
    return true;
  }

  // A scoped target (pkg::module) is not satisfied by an unrelated module's type string.
  const unscoped = !scope.module && !scope.function;

  for (const ev of trace.events ?? []) {
    if (moveTypePackage(ev.type) !== target) continue;
    if (unscoped) return true;
    if (scope.module && ev.type.includes(`::${scope.module}::`)) return true;
  }

  for (const obj of trace.objectChanges ?? []) {
    if (moveTypePackage(obj.objectType) !== target) continue;
    if (unscoped) return true;
    if (scope.module && obj.objectType.includes(`::${scope.module}::`)) return true;
  }

  return false;
}

/**
 * Splits `0x…`, `0x…::module`, or `0x…::module::function` into a package address and a scope.
 * Returns null when the string is not address-shaped at all (a free-text target).
 */
export function parseTarget(
  target: string
): { address: string; scope: TargetMatch } | null {
  const m = /^0x([0-9a-fA-F]{1,64})(?:::([^:]+))?(?:::([^:]+))?$/.exec(target.trim());
  if (!m) return null;
  return {
    address: `0x${m[1].toLowerCase().padStart(64, "0")}`,
    scope: { module: m[2], function: m[3] },
  };
}
