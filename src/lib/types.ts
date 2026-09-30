export type Severity = "low" | "medium" | "high" | "critical";

export interface Violation {
  type: string;
  severity: Severity;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface AnalysisReport {
  digest: string;
  network: string;
  timestamp: string;
  sender: string;
  success: boolean;
  violations: Violation[];
  /**
   * Detectors that threw while running. A report with detector errors is not a clean report:
   * an absent finding and an uncomputed finding are different statements.
   */
  detectorErrors: string[];
  stats: {
    balanceChanges: number;
    objectChanges: number;
    ptbCommands: number;
    events: number;
  };
}

/**
 * Who owns an object after a transaction, as far as the trace can say.
 *
 * `unresolved` and `unrecorded` are not the same statement and must never collapse. Unresolved
 * means the owner was looked at and could not be classified — in practice a change with no output
 * owner at all, which is what a deleted object looks like. Unrecorded means this trace was
 * normalised before owners were captured, so nobody looked.
 */
export type OwnerKind =
  | "address"
  | "consensus-address"
  | "object"
  | "immutable"
  | "shared"
  | "unresolved"
  | "unrecorded";

/** One violation type a checker can emit, with the severity it emits it at. */
export interface Emission {
  type: string;
  severity: Severity;
  /**
   * `false` means the type is reported but never counts as corroboration for anything else.
   * Corroboration is the mechanism that raises priority, so it should mean "a second detector
   * independently thinks this looks off" — not "this shape also appears in 2% of ordinary
   * traffic". A report-only type can still be escalated by stronger signals around it.
   */
  corroborates?: boolean;
}

export interface InvariantChecker {
  name: string;
  description: string;
  /**
   * Declared, not inferred. Triage scores an unknown violation type with a silent `?? 0`
   * confidence modifier, so a detector that emits a type nobody configured looks exactly like a
   * detector that was configured to be ignored. Requiring this field moves that mistake from a
   * quiet scoring artifact to a compile error in the one directory CI typechecks.
   */
  emits: Emission[];
  check: (trace: SuiTransactionTrace) => Violation[];
}

export interface SuiTransactionTrace {
  digest: string;
  network?: "mainnet" | "testnet" | "devnet";
  sender: string;
  success: boolean;
  balanceChanges: BalanceChange[];
  objectChanges: ObjectChange[];
  ptbCommands: PTBCommand[];
  events: SuiEvent[];
}

export interface BalanceChange {
  owner: string;
  coinType: string;
  amount: bigint;
}

export interface ObjectChange {
  objectId: string;
  objectType: string;
  changeType: string;
  recipient?: string;
  sender?: string;
  /**
   * Output owner, recorded at fetch time rather than derived at analysis time. Cached traces are
   * the normal case, not the exception, so anything a rule needs had better survive the cache —
   * two ownership rules used to reach for a `raw` response that `saveTrace` never writes.
   */
  outputOwnerKind?: OwnerKind;
  /** The owning object, when an object owns it: a dynamic field's parent, a wrapped cap. */
  outputOwnerId?: string;
}

export interface PTBCommand {
  index: number;
  kind: string;
  packageId?: string;
  module?: string;
  function?: string;
  /** true/false are determined answers; undefined means the signature could not be resolved. */
  returnsMutableRef?: boolean;
}

export interface SuiEvent {
  type: string;
  packageId: string;
  module: string;
  sender: string;
  parsedJson: Record<string, unknown>;
}
