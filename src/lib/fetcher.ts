import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  SuiTransactionTrace,
  BalanceChange,
  ObjectChange,
  PTBCommand,
  SuiEvent,
} from "./types.js";

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

const signatureCache = new Map<string, boolean>();

export class TraceFetcher {
  private client: SuiGrpcClient;
  private network: "mainnet" | "testnet" | "devnet";

  constructor(network: "mainnet" | "testnet" | "devnet" = "mainnet") {
    this.network = network;
    this.client = new SuiGrpcClient({
      network,
      baseUrl: `https://fullnode.${network}.sui.io:443`,
    });
  }

  async fetch(digest: string): Promise<SuiTransactionTrace> {
    const result = await withRetry(() =>
      this.client.core.getTransaction({
        digest,
        include: {
          transaction: true,
          effects: true,
          events: true,
          balanceChanges: true,
          objectTypes: true,
        },
      })
    );

    if (result.$kind !== "Transaction" || !result.Transaction) {
      throw new Error(`Transaction ${digest} not found`);
    }

    return await this.normalize(digest, result.Transaction);
  }

  private async normalize(digest: string, tx: any): Promise<SuiTransactionTrace> {
    const sender = tx.transaction?.sender ?? "unknown";

    const balanceChanges: BalanceChange[] = (tx.balanceChanges ?? []).map((b: any) => ({
      owner: b.address ?? "unknown",
      coinType: b.coinType ?? "unknown",
      amount: BigInt(b.amount ?? 0),
    }));

    const objectChanges: ObjectChange[] = (tx.effects?.changedObjects ?? []).map((o: any) => ({
      objectId: o.objectId ?? "unknown",
      objectType: o.objectType ?? "unknown",
      changeType: o.changeType ?? "mutated",
      recipient: o.recipient,
      sender: o.sender,
    }));

    const ptbCommands = await this.extractCommands(tx);

    const events: SuiEvent[] = (tx.events ?? []).map((e: any) => ({
      type: e.eventType ?? e.type ?? "unknown",
      packageId: e.packageId ?? "unknown",
      module: e.module ?? "unknown",
      sender: e.sender ?? "unknown",
      parsedJson: e.json ?? e.parsedJson ?? {},
    }));

    return {
      digest,
      sender,
      balanceChanges,
      objectChanges,
      ptbCommands,
      events,
      raw: tx,
    };
  }

  private async extractCommands(tx: any): Promise<PTBCommand[]> {
    const commands = tx.transaction?.commands ?? [];
    const result: PTBCommand[] = [];

    for (let index = 0; index < commands.length; index++) {
      const cmd = commands[index];
      const kind = cmd.$kind ?? "Unknown";

      if (kind === "MoveCall" && cmd.MoveCall) {
        const pkg = cmd.MoveCall.package;
        const module = cmd.MoveCall.module;
        const fn = cmd.MoveCall.function;
        const returnsMutableRef = await this.resolveReturnsMutable(pkg, module, fn);
        result.push({ index, kind, packageId: pkg, module, function: fn, returnsMutableRef });
      } else {
        result.push({ index, kind });
      }
    }

    return result;
  }

  private async resolveReturnsMutable(
    packageId: string,
    module: string,
    fn: string
  ): Promise<boolean> {
    const key = `${packageId}::${module}::${fn}`;
    const cached = signatureCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const sig = await withRetry(() =>
        (this.client.core as any).getMoveFunction({
          packageId,
          moduleName: module,
          name: fn,
        })
      );

      const f = sig?.function;
      if (!f) {
        signatureCache.set(key, false);
        return false;
      }

      // Only externally callable functions matter for this bug class
      if (f.visibility !== "public") {
        signatureCache.set(key, false);
        return false;
      }

      const returns = f.returns ?? [];
      const hasMutable = returns.some((r: any) => r?.reference === "mutable");
      signatureCache.set(key, hasMutable);
      return hasMutable;
    } catch (err) {
      console.error(`[chase] getMoveFunction failed for ${key}:`, err);
      return false;
    }
  }
}
