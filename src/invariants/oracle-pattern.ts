import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const ORACLE_KEYWORDS = ["update_price", "set_price", "refresh", "oracle"];
const DEFI_KEYWORDS = ["swap", "liquidate", "borrow", "withdraw"];

function matches(fn: string | undefined, keywords: string[]): boolean {
  if (!fn) return false;
  const lower = fn.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function isOracleCall(fn: string | undefined): boolean {
  return matches(fn, ORACLE_KEYWORDS);
}

function isDefiCall(fn: string | undefined): boolean {
  return matches(fn, DEFI_KEYWORDS);
}

export const oraclePattern: InvariantChecker = {
  name: "oracle-pattern",
  description:
    "Detects an oracle update followed by a DeFi action anywhere later in the same PTB (manipulation suspect)",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const cmds = trace.ptbCommands;

    // Any ordered pair (oracle index < DeFi index) is a candidate. Anchoring on the *first*
    // occurrence of each keyword class missed the real shape — e.g.
    // [swap_exact, update_price, liquidate] has its first DeFi call before its first oracle
    // call, so the update_price -> liquidate sequence was never reported.
    for (let oracleIdx = 0; oracleIdx < cmds.length; oracleIdx++) {
      if (!isOracleCall(cmds[oracleIdx].function)) continue;

      let defiIdx = -1;
      for (let i = oracleIdx + 1; i < cmds.length; i++) {
        if (isDefiCall(cmds[i].function)) {
          defiIdx = i;
          break;
        }
      }

      if (defiIdx === -1) continue;

      violations.push({
        type: "ORACLE_MANIPULATION_SUSPECTED",
        severity: "high",
        message: `Oracle update at cmd[${oracleIdx}] followed by DeFi action at cmd[${defiIdx}]`,
        evidence: {
          oracleCmd: cmds[oracleIdx],
          defiCmd: cmds[defiIdx],
          oracleIndex: oracleIdx,
          defiIndex: defiIdx,
        },
      });
    }

    return violations;
  },
};
