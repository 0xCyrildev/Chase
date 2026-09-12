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
  returnsMutableRef?: boolean;
}

export interface SuiEvent {
  type: string;
  packageId: string;
  module: string;
  sender: string;
  parsedJson: Record<string, unknown>;
}
