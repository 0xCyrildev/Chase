import { tokenConservation } from "./token-conservation.js";
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
  mutableAccess,
  ownershipAnomaly,
  oraclePattern,
  repeatedModuleCalls,
  reentrancyPattern,
  flashLoanShaped,
  capabilityTransfer,
];
