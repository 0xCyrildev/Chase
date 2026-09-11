import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const ORACLE_KEYWORDS = ["update_price", "set_price", "refresh", "oracle"];
const DEFI_KEYWORDS = ["swap", "liquidate", "borrow", "withdraw"];

export const oraclePattern: InvariantChecker = {
  name: "oracle-pattern",
  description: "Detects oracle update + DeFi action in same PTB (manipulation suspect)",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];

    const oracleIdx = trace.ptbCommands.findIndex(
      (c) => c.function && ORACLE_KEYWORDS.some((k) => c.function!.toLowerCase().includes(k))
    );

    const defiIdx = trace.ptbCommands.findIndex(
      (c) => c.function && DEFI_KEYWORDS.some((k) => c.function!.toLowerCase().includes(k))
    );

    if (oracleIdx !== -1 && defiIdx !== -1 && defiIdx > oracleIdx) {
      violations.push({
        type: "ORACLE_MANIPULATION_SUSPECTED",
        severity: "high",
        message: `Oracle update at cmd[${oracleIdx}] followed by DeFi action at cmd[${defiIdx}]`,
        evidence: {
          oracleCmd: trace.ptbCommands[oracleIdx],
          defiCmd: trace.ptbCommands[defiIdx],
        },
      });
    }

    return violations;
  },
};
