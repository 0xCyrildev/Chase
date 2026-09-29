import { TraceFetcher } from "../lib/fetcher.js";
import { SuiTransactionTrace } from "../lib/types.js";

/**
 * What an investigation is for: triage has already decided a tier from violation counts. Reading a
 * transaction adds something only if it reports *what was in the transaction* — the calls, the value
 * movement, and the specific names that made each signal fire — and says which layer formed the
 * judgement. An investigator that re-derives a verdict from the tier answers a question nobody asked.
 */

export interface InvestigationViolation {
  type: string;
  severity: string;
  message: string;
  evidence?: Record<string, unknown>;
}

/** The subset of a triaged finding an investigation needs, declared here to avoid a scout↔investigator cycle. */
export interface FindingForInvestigation {
  digest: string;
  violations: InvestigationViolation[];
  tier?: string;
  score?: number;
  action?: string;
}

export interface InvestigationEvidence {
  sender: string;
  success: boolean;
  commandCount: number;
  /** Every PTB command, in order: `[i] PackageMutate::module::function` style, truncated by the caller if needed. */
  commands: string[];
  /** Distinct packages called, most calls first. */
  packages: { package: string; calls: number }[];
  /**
   * The names that made each non-low signal fire, so a reader can check the claim against the chain.
   * Identical firings collapse into one entry with a count: a 28-command PTB that trips the oracle
   * heuristic three times on the same pair of names has one fact to report, not three.
   */
  signals: { type: string; severity: string; matched: string[]; count: number }[];
  /** Coin movements, largest first, as `owner ±amount coin`. */
  movements: string[];
  /** Objects that changed hands. */
  transfers: string[];
  /** Event types emitted, most frequent first. */
  events: { type: string; count: number }[];
  /** Detectors that threw: an absent signal is not an absent pattern. */
  notes: string[];
}

export type InvestigationSource = "model" | "rules" | "stub" | "fallback";

export interface InvestigationInput {
  digest: string;
  network: string;
  tier?: string;
  score?: number;
  action?: string;
  violations: InvestigationViolation[];
  evidence: InvestigationEvidence;
}

export interface InvestigationOutcome {
  verdict: "benign" | "suspicious" | "needs-review";
  hypothesis: string;
  reasoning: string;
  /** Set by whichever layer answered: a reading from a rules table must not read as a model's. */
  source: InvestigationSource;
  /** Which model answered, when a model did — a security report should name its source. */
  model?: string;
  /** True when the answer is Chase's own last resort rather than the layer that was asked. */
  degraded?: boolean;
  /** Tokens the provider reported, when it reports usage. */
  tokens?: number;
}

export interface InvestigationResult extends InvestigationOutcome {
  digest: string;
  evidence: InvestigationEvidence;
  degraded: boolean;
  tier?: string;
  action?: string;
  score?: number;
}

const MAX_COMMANDS = 40;
const MAX_MOVEMENTS = 8;
const MAX_SIGNALS = 12;
const MAX_NAME = 90;

export async function investigate(
  finding: FindingForInvestigation,
  network: "mainnet" | "testnet" | "devnet",
  ask: (input: InvestigationInput) => Promise<InvestigationOutcome>
): Promise<InvestigationResult> {
  let evidence: InvestigationEvidence;
  try {
    evidence = await readTransaction(finding, network);
  } catch (err: any) {
    // The reading still happens, over the evidence triage already produced, and says it is thin.
    evidence = emptyEvidence();
    evidence.notes.push(`trace unreadable: ${String(err?.message ?? err).slice(0, 160)}`);
  }

  let outcome: InvestigationOutcome;
  try {
    outcome = await ask({
      digest: finding.digest,
      network,
      tier: finding.tier,
      score: finding.score,
      action: finding.action,
      violations: finding.violations,
      evidence,
    });
  } catch (err: any) {
    outcome = {
      verdict: "needs-review",
      hypothesis: "unread",
      reasoning: `no reading: ${String(err?.message ?? err).slice(0, 160)}`,
      source: "fallback",
      degraded: true,
    };
  }

  return {
    ...outcome,
    degraded: outcome.degraded ?? false,
    digest: finding.digest,
    evidence,
    tier: finding.tier,
    action: finding.action,
    score: finding.score,
  };
}

/**
 * Assemble what the transaction actually contains. One read, against the trace cache — the finding's
 * own violations are reused rather than re-derived, so escalation costs one call and not four.
 */
export async function readTransaction(
  finding: FindingForInvestigation,
  network: "mainnet" | "testnet" | "devnet"
): Promise<InvestigationEvidence> {
  const fetcher = new TraceFetcher(network, true);
  const trace = await fetcher.fetch(finding.digest);
  return describe(finding, trace);
}

export function describe(
  finding: FindingForInvestigation,
  trace: SuiTransactionTrace
): InvestigationEvidence {
  const cmds = trace.ptbCommands ?? [];
  const callCounts = new Map<string, number>();

  const commands = cmds.slice(0, MAX_COMMANDS).map((cmd) => {
    if (cmd.packageId) {
      callCounts.set(short(cmd.packageId), (callCounts.get(short(cmd.packageId)) ?? 0) + 1);
    }
    const call = cmd.module
      ? `${short(cmd.packageId ?? "?")}::${cmd.module}::${cmd.function ?? "?"}`
      : "";
    const mut = cmd.returnsMutableRef === true ? " mut" : "";
    return `[${cmd.index}] ${cmd.kind}${call ? ` ${call}` : ""}${mut}`;
  });

  const packages = [...callCounts.entries()]
    .map(([pkg, calls]) => ({ package: pkg, calls }))
    .sort((a, b) => b.calls - a.calls);

  const movements = (trace.balanceChanges ?? [])
    .filter((b) => b.amount !== 0n)
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))
    .slice(0, MAX_MOVEMENTS)
    .map((b) => `${short(b.owner)} ${b.amount > 0n ? "+" : ""}${b.amount} ${shortType(b.coinType)}`);

  const transfers = (trace.objectChanges ?? [])
    .filter((o) => o.changeType === "moved" || (o.recipient && o.recipient !== trace.sender))
    .slice(0, MAX_MOVEMENTS)
    .map((o) => `${o.changeType} ${short(o.objectId)} ${shortType(o.objectType)}${o.recipient ? ` -> ${short(o.recipient)}` : ""}`);

  const eventCounts = new Map<string, number>();
  for (const ev of trace.events ?? []) {
    const key = ev.type.split("::").slice(-2).join("::") || ev.type;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const events = [...eventCounts.entries()]
    .map(([type, count]) => ({ type: clip(type, MAX_NAME), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const signalByKey = new Map<string, InvestigationEvidence["signals"][number]>();
  for (const v of finding.violations) {
    if (v.severity !== "high" && v.severity !== "critical") continue;
    const matched = matchedNames(v.evidence);
    const key = `${v.type}|${v.severity}|${matched.join(",")}`;
    const existing = signalByKey.get(key);
    if (existing) existing.count++;
    else signalByKey.set(key, { type: v.type, severity: v.severity, matched, count: 1 });
  }
  const signals = [...signalByKey.values()].sort((a, b) => b.count - a.count).slice(0, MAX_SIGNALS);

  const notes: string[] = [];
  if (cmds.length > MAX_COMMANDS) {
    notes.push(`${cmds.length - MAX_COMMANDS} of ${cmds.length} commands not listed here`);
  }
  if (!trace.success) {
    notes.push("transaction reverted on-chain");
  }

  return {
    sender: short(trace.sender),
    success: trace.success,
    commandCount: cmds.length,
    commands,
    packages,
    signals,
    movements,
    transfers,
    events,
    notes,
  };
}

/**
 * The names a detector matched on. Each keyword-based invariant records the command or module it
 * keyed off; showing them is what lets a reader disagree with a tier instead of taking it on trust.
 * Deliberately shape-specific rather than a deep walk: `note` fields are prose a detector wrote
 * about its own limits, and repeating them here would drown the names.
 */
function matchedNames(evidence?: Record<string, unknown>): string[] {
  if (!evidence) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const clipped = clip(value, MAX_NAME);
    if (out.length < 8 && !out.includes(clipped)) out.push(clipped);
  };

  const asCommand = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cmd = value as Record<string, any>;
    if (typeof cmd.module !== "string" && typeof cmd.function !== "string") return null;
    const pkgAddr = cmd.packageId ?? cmd.package ?? cmd.calleePackage;
    const pkg = typeof pkgAddr === "string" && pkgAddr.startsWith("0x") ? `${short(pkgAddr)}::` : "";
    return `${pkg}${cmd.module ?? "?"}::${cmd.function ?? "?"}`;
  };

  // Some detectors record a whole command (oracle, flash-loan, mutable-access) and some record the
  // pieces flat ({module, count} or {function}). Both are names a reader can check, so both are
  // reported — the shape difference is the detectors', not the reader's problem.
  const rootCommand = asCommand(evidence);
  if (rootCommand) add(rootCommand);

  for (const [key, value] of Object.entries(evidence)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemCmd = asCommand(item);
        if (itemCmd) add(itemCmd);
      }
      continue;
    }
    const cmd = asCommand(value);
    if (cmd) {
      add(cmd);
      continue;
    }
    if (rootCommand) continue;
    if (key === "module" && typeof value === "string") {
      add(typeof evidence.count === "number" ? `${value} ×${evidence.count}` : value);
    }
    if (key === "function" && typeof value === "string") add(value);
    if ((key === "coinType" || key === "objectType" || key === "type") && typeof value === "string") {
      add(shortType(value));
    }
    if (key === "net" && typeof value === "string") add(`net=${value}`);
  }

  return out;
}

function emptyEvidence(): InvestigationEvidence {
  return {
    sender: "unknown",
    success: false,
    commandCount: 0,
    commands: [],
    packages: [],
    signals: [],
    movements: [],
    transfers: [],
    events: [],
    notes: [],
  };
}

export function short(address: string): string {
  return address.startsWith("0x")
    ? `${address.slice(0, 8)}…`
    : address.slice(0, 10);
}

function shortType(type: string): string {
  const parts = type.split("::");
  if (parts.length < 2) return clip(type, 24);
  const tail = parts.slice(1).join("::");
  return clip(tail, 32);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
