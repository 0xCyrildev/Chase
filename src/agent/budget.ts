export interface BudgetLimits {
  maxRpcCalls: number;
  maxLlmCalls: number;
  maxLlmTokens: number;
  maxWallMs: number;
}

export interface BudgetUsage {
  rpcCalls: number;
  llmCalls: number;
  llmTokens: number;
  elapsedMs: number;
}

export class BudgetExceeded extends Error {
  constructor(
    public readonly kind: "rpc" | "llm" | "tokens" | "time",
    public readonly used: number,
    public readonly limit: number
  ) {
    super(`Budget exceeded: ${kind} (used ${used}, limit ${limit})`);
    this.name = "BudgetExceeded";
  }
}

export class Budget {
  private rpcCalls = 0;
  private llmCalls = 0;
  private llmTokens = 0;
  private startedAt = Date.now();

  constructor(private readonly limits: BudgetLimits) {}

  spendRpc(count = 1): void {
    this.rpcCalls += count;
    if (this.rpcCalls > this.limits.maxRpcCalls) {
      throw new BudgetExceeded("rpc", this.rpcCalls, this.limits.maxRpcCalls);
    }
    this.checkTime();
  }

  spendLlm(tokens: number): void {
    this.llmCalls++;
    this.llmTokens += tokens;

    if (this.llmCalls > this.limits.maxLlmCalls) {
      throw new BudgetExceeded("llm", this.llmCalls, this.limits.maxLlmCalls);
    }
    if (this.llmTokens > this.limits.maxLlmTokens) {
      throw new BudgetExceeded("tokens", this.llmTokens, this.limits.maxLlmTokens);
    }
    this.checkTime();
  }

  checkTime(): void {
    const elapsed = this.elapsedMs();
    if (elapsed > this.limits.maxWallMs) {
      throw new BudgetExceeded("time", elapsed, this.limits.maxWallMs);
    }
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  remaining(): {
    rpc: number;
    llm: number;
    tokens: number;
    ms: number;
  } {
    return {
      rpc: this.limits.maxRpcCalls - this.rpcCalls,
      llm: this.limits.maxLlmCalls - this.llmCalls,
      tokens: this.limits.maxLlmTokens - this.llmTokens,
      ms: this.limits.maxWallMs - this.elapsedMs(),
    };
  }

  usage(): BudgetUsage {
    return {
      rpcCalls: this.rpcCalls,
      llmCalls: this.llmCalls,
      llmTokens: this.llmTokens,
      elapsedMs: this.elapsedMs(),
    };
  }

  /** Throw if any budget dimension is exhausted. */
  assertNotExhausted(): void {
    this.checkTime();
    if (this.rpcCalls >= this.limits.maxRpcCalls) {
      throw new BudgetExceeded("rpc", this.rpcCalls, this.limits.maxRpcCalls);
    }
    if (this.llmCalls >= this.limits.maxLlmCalls) {
      throw new BudgetExceeded("llm", this.llmCalls, this.limits.maxLlmCalls);
    }
    if (this.llmTokens >= this.limits.maxLlmTokens) {
      throw new BudgetExceeded("tokens", this.llmTokens, this.limits.maxLlmTokens);
    }
  }

  /** True if a soft stop should be considered (90% of any dimension). */
  nearLimit(): boolean {
    return (
      this.rpcCalls >= this.limits.maxRpcCalls * 0.9 ||
      this.llmCalls >= this.limits.maxLlmCalls * 0.9 ||
      this.elapsedMs() >= this.limits.maxWallMs * 0.9
    );
  }
}
