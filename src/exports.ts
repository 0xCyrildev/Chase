/**
 * Library entry point. `dist/index.js` is the CLI and parses process.argv on import, so
 * programmatic consumers must import this module instead.
 */
export { runAnalysis, analyzeCommand } from "./commands/analyze.js";
export type { Network, AnalyzeOptions } from "./commands/analyze.js";
export { batchCommand } from "./commands/batch.js";
export { watchCommand } from "./commands/watch.js";
export {
  TraceFetcher,
  NonProgrammableTransaction,
  type ListedTransaction,
  type ListedTransactions,
} from "./lib/fetcher.js";
export type {
  SuiTransactionTrace,
  AnalysisReport,
  Violation,
  Severity,
  InvariantChecker,
} from "./lib/types.js";
export { allInvariants } from "./invariants/index.js";
export { isDigest, assertDigest } from "./lib/digest.js";
export { triage } from "./triage/index.js";
export { scout, type ScoutLLM, type ScoutOptions, type SummaryOutcome } from "./agent/scout.js";
/**
 * The investigator on its own, because it is a layer rather than a detail of the scout: `scout` decides
 * what to read, `investigate` reads what you already named. Same one-fetch shape as `chase_investigate`,
 * so a script, an MCP client and the CLI can reach the same reading.
 */
export {
  investigate,
  readTransaction,
  type FindingForInvestigation,
  type InvestigationEvidence,
  type InvestigationInput,
  type InvestigationOutcome,
  type InvestigationResult,
  type InvestigationSource,
} from "./agent/investigator.js";
export { RuleBasedLLM } from "./agent/rules-llm.js";
export { StubLLM } from "./agent/stub-llm.js";
export { RealLLM } from "./agent/llm.js";
export { loadMandate, validateMandate } from "./agent/mandate.js";
export { Budget, BudgetExceeded } from "./agent/budget.js";
export { toMarkdown } from "./agent/report-md.js";
export type {
  Mandate,
  AgentReport,
  ScanCoverage,
  ScanResult,
  ScoutDecision,
} from "./agent/types.js";
