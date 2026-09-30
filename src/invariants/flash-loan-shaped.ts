import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

// "flash_swap" is Cetus's borrow-side entry point (flash_swap … repay_flash_swap) and it appears on
// real mainnet volume; without it the detector reads a flash loan as three unrelated calls, because
// "flash_swap" matches ACTION_KEYWORDS only. Measured 2026-09-29 on organic traffic, that is the
// shape an escalated transaction had while FLASH_LOAN_SHAPED stayed silent.
const BORROW_KEYWORDS = ["borrow", "flash_loan", "flashloan", "flash_swap", "loan"];
const REPAY_KEYWORDS = ["repay", "return_flash", "return_loan", "flash_repay"];
const ACTION_KEYWORDS = ["swap", "liquidate", "arbitrage", "trade", "execute"];

function fnMatches(fn: string | undefined, keywords: string[]): boolean {
  if (!fn) return false;
  const lower = fn.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export const flashLoanShaped: InvariantChecker = {
  name: "flash-loan-shaped",
  description:
    "Flags borrow -> action -> repay sequences within a single PTB (flash loan pattern)",
  emits: [{ type: "FLASH_LOAN_SHAPED", severity: "medium" }],
  check(trace: SuiTransactionTrace): Violation[] {
    const cmds = trace.ptbCommands;
    const violations: Violation[] = [];

    const borrowIdx = cmds.findIndex((c) => fnMatches(c.function, BORROW_KEYWORDS));
    if (borrowIdx === -1) return violations;

    const actionIdx = cmds.findIndex(
      (c, i) => i > borrowIdx && fnMatches(c.function, ACTION_KEYWORDS)
    );
    if (actionIdx === -1) return violations;

    const repayIdx = cmds.findIndex(
      (c, i) => i > actionIdx && fnMatches(c.function, REPAY_KEYWORDS)
    );
    if (repayIdx === -1) return violations;

    violations.push({
      type: "FLASH_LOAN_SHAPED",
      severity: "medium",
      message: `borrow at cmd[${borrowIdx}], action at cmd[${actionIdx}], repay at cmd[${repayIdx}]`,
      evidence: {
        borrow: cmds[borrowIdx],
        action: cmds[actionIdx],
        repay: cmds[repayIdx],
      },
    });

    return violations;
  },
};
