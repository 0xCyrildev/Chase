import { tokenConservation } from "./token-conservation.js";
import { coinNetImbalance } from "./coin-net-imbalance.js";
import { dynamicFieldLifecycle } from "./dynamic-field-lifecycle.js";
import { silentObjectChange } from "./silent-object-change.js";
import { mutableAccess } from "./mutable-access.js";
import { ownershipAnomaly } from "./ownership-anomaly.js";
import { oraclePattern } from "./oracle-pattern.js";
import { repeatedModuleCalls } from "./repeated-module-calls.js";
import { reentrancyPattern } from "./reentrancy-pattern.js";
import { flashLoanShaped } from "./flash-loan-shaped.js";
import { capabilityTransfer } from "./capability-transfer.js";
import { InvariantChecker } from "../lib/types.js";

export const allInvariants: InvariantChecker[] = [
  tokenConservation,
  coinNetImbalance,
  dynamicFieldLifecycle,
  silentObjectChange,
  mutableAccess,
  ownershipAnomaly,
  oraclePattern,
  repeatedModuleCalls,
  reentrancyPattern,
  flashLoanShaped,
  capabilityTransfer,
];
