import { Budget, BudgetExceeded } from "../src/agent/budget.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

{
  const b = new Budget({
    maxRpcCalls: 3,
    maxLlmCalls: 10,
    maxLlmTokens: 1000,
    maxWallMs: 60000,
  });

  b.spendRpc();
  b.spendRpc();
  b.spendRpc();

  let threw = false;
  try {
    b.spendRpc();
  } catch (e) {
    threw = e instanceof BudgetExceeded;
  }
  assert(threw, "rpc budget should throw on 4th call");
  assert(b.usage().rpcCalls === 4, "usage should reflect overage");
  console.log("rpc budget: ok");
}

{
  const b = new Budget({
    maxRpcCalls: 100,
    maxLlmCalls: 2,
    maxLlmTokens: 1000,
    maxWallMs: 60000,
  });

  b.spendLlm(100);
  b.spendLlm(100);

  let threw = false;
  try {
    b.spendLlm(100);
  } catch (e) {
    threw = e instanceof BudgetExceeded && (e as BudgetExceeded).kind === "llm";
  }
  assert(threw, "llm budget should throw on 3rd call");
  console.log("llm calls: ok");
}

{
  const b = new Budget({
    maxRpcCalls: 100,
    maxLlmCalls: 10,
    maxLlmTokens: 500,
    maxWallMs: 60000,
  });

  b.spendLlm(300);

  let threw = false;
  try {
    b.spendLlm(300);
  } catch (e) {
    threw = e instanceof BudgetExceeded && (e as BudgetExceeded).kind === "tokens";
  }
  assert(threw, "token budget should throw when exceeded");
  console.log("token budget: ok");
}

{
  const b = new Budget({
    maxRpcCalls: 100,
    maxLlmCalls: 10,
    maxLlmTokens: 5000,
    maxWallMs: 60000,
  });

  b.spendRpc(40);
  b.spendLlm(500);
  b.spendLlm(300);

  const r = b.remaining();
  assert(r.rpc === 60, `remaining rpc should be 60, got ${r.rpc}`);
  assert(r.llm === 8, `remaining llm should be 8, got ${r.llm}`);
  assert(r.tokens === 4200, `remaining tokens should be 4200, got ${r.tokens}`);
  console.log("remaining: ok");
}

{
  const b = new Budget({
    maxRpcCalls: 100,
    maxLlmCalls: 10,
    maxLlmTokens: 5000,
    maxWallMs: 100,
  });

  await new Promise((r) => setTimeout(r, 150));

  let threw = false;
  try {
    b.checkTime();
  } catch (e) {
    threw = e instanceof BudgetExceeded && (e as BudgetExceeded).kind === "time";
  }
  assert(threw, "time budget should throw when exceeded");
  console.log("time budget: ok");
}

console.log("\nall budget tests passed");
