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

export interface InvariantChecker {
  name: string;
  description: string;
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
  raw: unknown;
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
