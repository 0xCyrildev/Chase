import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  SuiTransactionTrace,
  BalanceChange,
  ObjectChange,
  PTBCommand,
  SuiEvent,
} from "./types.js";
import { loadTrace, saveTrace } from "./cache.js";

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
  private fullnode: SuiGrpcClient;
  private archival: SuiGrpcClient | null;
  private network: "mainnet" | "testnet" | "devnet";
  private useCache: boolean;

  constructor(network: "mainnet" | "testnet" | "devnet" = "mainnet", useCache = true) {
    this.network = network;
    this.useCache = useCache;
    this.fullnode = new SuiGrpcClient({
      network,
      baseUrl: `https://fullnode.${network}.sui.io:443`,
    });

    this.archival =
      network === "mainnet"
        ? new SuiGrpcClient({
            network,
            baseUrl: "https://archive.mainnet.sui.io:443",
          })
        : null;
  }

  async fetch(digest: string): Promise<SuiTransactionTrace> {
    if (this.useCache) {
      const cached = loadTrace(digest);
      if (cached) return cached;
    }

    const trace = await this.fetchUncached(digest);

    if (this.useCache) saveTrace(trace);

    return trace;
  }

  private async fetchUncached(digest: string): Promise<SuiTransactionTrace> {
    try {
      return await this.fetchFrom(this.fullnode, digest);
    } catch (err: any) {
      if (err?.reason === "notFound" && this.archival) {
        console.error(`[chase] not found on fullnode, trying archival...`);
        return await this.fetchFrom(this.archival, digest);
      }
      throw err;
    }
  }

  private async fetchFrom(client: SuiGrpcClient, digest: string): Promise<SuiTransactionTrace> {
    const result = await withRetry(() =>
      client.core.getTransaction({
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

  async getCheckpointHeight(): Promise<{ current: bigint; lowest: bigint }> {
    const wrapper = await (this.fullnode.ledgerService as any).getServiceInfo({});
    const info = wrapper?.response ?? wrapper;

    const current = BigInt(info?.checkpointHeight ?? 0);
    const lowest = BigInt(info?.lowestAvailableCheckpoint ?? 0);

    return { current, lowest };
  }

  async getCheckpointTransactions(seq: bigint): Promise<string[]> {
    const wrapper = await (this.fullnode.ledgerService as any).getCheckpoint({
      checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: seq },
      readMask: ["transactions"],
    });

    const cp = wrapper?.response?.checkpoint ?? wrapper?.response;
    const txs = cp?.transactions ?? [];

    return txs
      .map((t: any) => (typeof t === "string" ? t : t.digest))
      .filter((d: any): d is string => typeof d === "string" && d.length > 0);
  }

  private async normalize(digest: string, tx: any): Promise<SuiTransactionTrace> {
    const sender = tx.transaction?.sender ?? "unknown";
    const objectTypes: Record<string, string> = tx.objectTypes ?? {};

    const balanceChanges: BalanceChange[] = (tx.balanceChanges ?? []).map((b: any) => ({
      owner: b.address ?? "unknown",
      coinType: b.coinType ?? "unknown",
      amount: BigInt(b.amount ?? 0),
    }));

    const objectChanges: ObjectChange[] = (tx.effects?.changedObjects ?? []).map((o: any) => {
      const inputExists = o.inputState === "Exists";
      const outputExists = o.outputState === "ObjectWrite";

      let changeType: string;
      if (!inputExists && outputExists) changeType = "created";
      else if (inputExists && !outputExists) changeType = "deleted";
      else changeType = "mutated";

      return {
        objectId: o.objectId ?? "unknown",
        objectType: objectTypes[o.objectId] ?? "unknown",
        changeType,
        sender: extractAddress(o.inputOwner),
        recipient: extractAddress(o.outputOwner),
      };
    });

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
        (this.fullnode.core as any).getMoveFunction({
          packageId,
          moduleName: module,
          name: fn,
        })
      );

      const f = sig?.function ?? sig?.response?.function;
      if (!f) {
        signatureCache.set(key, false);
        return false;
      }

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

function extractAddress(owner: any): string | undefined {
  if (!owner) return undefined;
  if (owner.$kind === "AddressOwner" && typeof owner.AddressOwner === "string") {
    return owner.AddressOwner;
  }
  if (typeof owner === "string") return owner;
  return undefined;
}
