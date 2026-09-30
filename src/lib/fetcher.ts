import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  SuiTransactionTrace,
  BalanceChange,
  ObjectChange,
  PTBCommand,
  SuiEvent,
} from "./types.js";
import { loadTrace, saveTrace } from "./cache.js";
import { assertDigest } from "./digest.js";
import { ownerAddress } from "./owner.js";
import { getSignature, setSignature } from "./sigcache.js";

// sui.rpc.v2 QUERY_END_REASON_CHECKPOINT_BOUND — the requested range was walked to its bound.
// ITEM_LIMIT (1) and SCAN_LIMIT (2) both mean the result set was truncated before the bound.
const CHECKPOINT_BOUND = 3;

/**
 * Sui transactions that carry no programmable body — consensus prologue, randomness
 * state update, epoch change and similar system transactions. The SDK's high-level
 * getTransaction rejects these with an untyped Error, so they are classified here.
 */
export class NonProgrammableTransaction extends Error {
  constructor(digest: string) {
    super(`transaction ${digest} has no programmable body (system transaction)`);
    this.name = "NonProgrammableTransaction";
  }
}

export interface ListedTransaction {
  digest: string;
  checkpoint: bigint | null;
}

export interface ListedTransactions {
  transactions: ListedTransaction[];
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  checkpoints: number;
  complete: boolean;
  endReason: number | null;
}

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

/**
 * Endpoint resolution. An override is validated rather than passed through: a typo here would
 * otherwise show up much later as an opaque fetch failure on every transaction, and a plain http
 * endpoint would silently leak the digest query in cleartext.
 */
function resolveEndpoint(kind: "fullnode" | "archive", network: string): string {
  const envName = kind === "fullnode" ? "SUI_RPC_URL" : "SUI_ARCHIVE_URL";
  const value = (process.env[envName] ?? "").trim();
  if (value === "") {
    return kind === "fullnode"
      ? `https://fullnode.${network}.sui.io:443`
      : "https://archive.mainnet.sui.io:443";
  }
  if (!/^https:\/\/[^\s]+$/.test(value)) {
    throw new Error(`${envName} must be an https:// URL, got: ${value.slice(0, 80)}`);
  }
  return value.replace(/\/+$/, "");
}

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
      baseUrl: resolveEndpoint("fullnode", network),
    });

    // Historically an archive client was built for mainnet only, because the public archive serves
    // mainnet. Pointing SUI_ARCHIVE_URL at a provider or a self-run node is the only way to actually
    // query history beyond the public retention window, so an explicit URL enables it on any network
    // — and it is on the operator that the endpoint matches the network they asked for.
    const archiveExplicit = (process.env.SUI_ARCHIVE_URL ?? "").trim() !== "";
    this.archival =
      network === "mainnet" || archiveExplicit
        ? new SuiGrpcClient({
            network,
            baseUrl: resolveEndpoint("archive", network),
          })
        : null;
  }

  async fetch(digest: string): Promise<SuiTransactionTrace> {
    assertDigest(digest);

    if (this.useCache) {
      const cached = loadTrace(digest, this.network);
      if (cached) return cached;
    }

    const trace = await this.fetchUncached(digest);
    trace.network = this.network;

    if (this.useCache) saveTrace(trace);

    return trace;
  }

  private async fetchUncached(digest: string): Promise<SuiTransactionTrace> {
    try {
      return await this.fetchFrom(this.fullnode, digest);
    } catch (err: any) {
      if (err?.reason !== "notFound" || !this.archival) throw err;

      console.error(`[chase] not found on fullnode, trying archival...`);
      try {
        return await this.fetchFrom(this.archival, digest);
      } catch (archiveErr: any) {
        // Measured 2026-09-29: the public archive endpoint answers (it is not an auth wall) but returns
        // notFound for digests the fullnode has already pruned — including two of this repo's own
        // mainnet fixtures. So the fallback is attempted and does not recover history; say that rather
        // than letting a second bare notFound imply someone typed the wrong digest.
        if (archiveErr?.reason === "notFound") {
          const e = new Error(
            `transaction ${digest} not found on the fullnode or the archive endpoint — ` +
              `pruned by the retention window (~21 days on public mainnet), or wrong network`
          ) as Error & { reason?: string };
          e.reason = "notFound";
          throw e;
        }
        throw archiveErr;
      }
    }
  }

  private async fetchFrom(client: SuiGrpcClient, digest: string): Promise<SuiTransactionTrace> {
    let result: any;
    try {
      result = await withRetry(() =>
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
    } catch (err: any) {
      if (String(err?.message ?? "").includes("Only programmable transactions")) {
        throw new NonProgrammableTransaction(digest);
      }
      // A gRPC RpcError can arrive with an empty message. In a sweep that turns "these transactions
      // could not be read" into silent gaps — nine of them appeared in one 1,106-transaction run
      // today with nothing but "RpcError" to explain it. Name the code and detail instead.
      if (typeof err?.message === "string" && err.message.trim() === "") {
        const code = err?.codeName ?? (typeof err?.code === "number" ? `code ${err.code}` : "unknown");
        const detail =
          typeof err?.details === "string" && err.details ? ` — ${err.details.slice(0, 160)}` : "";
        const wrapped = new Error(
          `gRPC ${err?.constructor?.name ?? "RpcError"} ${code}${detail} while reading ${digest.slice(0, 12)}…`
        ) as Error & { reason?: string; code?: unknown };
        wrapped.reason = err?.reason;
        wrapped.code = err?.code;
        throw wrapped;
      }
      throw err;
    }

    const kind = result.$kind ?? "Transaction";
    const tx = (result as any).Transaction ?? (result as any)[kind] ?? null;

    if (!tx) {
      throw new Error(`Transaction ${digest} not found`);
    }

    return await this.normalize(digest, tx);
  }

  async getCheckpointHeight(): Promise<{ current: bigint; lowest: bigint }> {
    const wrapper: any = await withRetry(async () =>
      (this.fullnode.ledgerService as any).getServiceInfo({})
    );
    const info = wrapper?.response ?? wrapper;

    const current = BigInt(info?.checkpointHeight ?? 0);
    const lowest = BigInt(info?.lowestAvailableCheckpoint ?? 0);

    if (current === 0n) {
      throw new Error("checkpoint height lookup returned no height");
    }

    return { current, lowest };
  }

  async getCheckpointTransactions(seq: bigint): Promise<string[]> {
    const wrapper: any = await withRetry(() =>
      (this.fullnode.ledgerService as any).getCheckpoint({
        checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: seq },
        // FieldMask is a message, so a bare string[] throws in the binary writer with an
        // empty message. The nested path pulls digests only: ~3KB vs ~1.3MB per checkpoint.
        readMask: { paths: ["transactions.digest"] },
      })
    );

    const cp = wrapper?.response?.checkpoint ?? wrapper?.response;
    if (!cp || !Array.isArray(cp.transactions)) {
      throw new Error(
        `checkpoint ${seq}: unexpected response shape (keys: ${Object.keys(cp ?? {}).join(",")})`
      );
    }

    return cp.transactions
      .map((t: any) => (typeof t === "string" ? t : t.digest))
      .filter((d: any): d is string => typeof d === "string" && d.length > 0);
  }

  async listTransactions(opts: {
    startCheckpoint: bigint;
    endCheckpoint: bigint;
    moveCallFunction?: string;
    limit?: number;
  }): Promise<ListedTransactions> {
    const call: any = (this.fullnode.ledgerService as any).listTransactions({
      readMask: { paths: ["digest", "checkpoint"] },
      startCheckpoint: opts.startCheckpoint,
      endCheckpoint: opts.endCheckpoint,
      filter: opts.moveCallFunction
        ? {
            terms: [
              {
                literals: [
                  {
                    negated: false,
                    predicate: {
                      oneofKind: "moveCall",
                      moveCall: { function: opts.moveCallFunction },
                    },
                  },
                ],
              },
            ],
          }
        : undefined,
      options: { limit: opts.limit ?? 1000 },
    });

    const transactions: ListedTransaction[] = [];
    let endReason: number | null = null;

    // Streaming calls are thenable: awaiting one resolves its finish promise and
    // discards the response stream, so the call object must not be awaited here.
    for await (const frame of call.responses) {
      if (frame?.end?.reason !== undefined) endReason = frame.end.reason;
      const digest = frame?.transaction?.digest;
      if (typeof digest === "string") {
        const cp = frame.transaction.checkpoint;
        transactions.push({
          digest,
          checkpoint: cp === undefined || cp === null ? null : BigInt(cp),
        });
      }
    }

    return {
      transactions,
      startCheckpoint: opts.startCheckpoint,
      endCheckpoint: opts.endCheckpoint,
      checkpoints: Number(opts.endCheckpoint - opts.startCheckpoint + 1n),
      complete: endReason === CHECKPOINT_BOUND,
      endReason,
    };
  }

  private async normalize(digest: string, tx: any): Promise<SuiTransactionTrace> {
    const sender = tx.transaction?.sender ?? "unknown";
    const objectTypes: Record<string, string> = tx.objectTypes ?? {};

    let success = true;
    if (tx.status && typeof tx.status.success === "boolean") {
      success = tx.status.success;
    } else if (tx.status?.$kind === "Failure" || tx.status?.$kind === "Failed") {
      success = false;
    }

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
        sender: ownerAddress(o.inputOwner),
        recipient: ownerAddress(o.outputOwner),
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
      success,
      balanceChanges,
      objectChanges,
      ptbCommands,
      events,
      raw: tx,
    };
  }

  private async extractCommands(tx: any): Promise<PTBCommand[]> {
    const commands = tx.transaction?.commands ?? [];

    // Signature lookups are independent; resolving them one at a time makes a 20-command PTB
    // cost 20 sequential round trips.
    return await Promise.all(
      commands.map(async (cmd: any, index: number): Promise<PTBCommand> => {
        const kind = cmd.$kind ?? "Unknown";

        if (kind !== "MoveCall" || !cmd.MoveCall) {
          return { index, kind };
        }

        const pkg = cmd.MoveCall.package;
        const module = cmd.MoveCall.module;
        const fn = cmd.MoveCall.function;
        const returnsMutableRef = await this.resolveReturnsMutable(pkg, module, fn);
        return { index, kind, packageId: pkg, module, function: fn, returnsMutableRef };
      })
    );
  }

  /**
   * false is a determined answer ("this function returns no mutable reference"). undefined means
   * the signature could not be resolved, and is never cached: collapsing an RPC failure into false
   * would silently delete a high-severity finding and record it as a clean result.
   */
  private async resolveReturnsMutable(
    packageId: string,
    module: string,
    fn: string
  ): Promise<boolean | undefined> {
    const key = `${packageId}::${module}::${fn}`;
    const cached = getSignature(key);
    if (cached !== undefined) return cached;

    let sig: any;
    try {
      sig = await withRetry(() =>
        (this.fullnode.core as any).getMoveFunction({
          packageId,
          moduleName: module,
          name: fn,
        })
      );
    } catch (err: any) {
      console.error(
        `[chase] getMoveFunction failed for ${key}: ${String(err?.message ?? err).slice(0, 160)}`
      );
      return undefined;
    }

    const f = sig?.function ?? sig?.response?.function;
    if (!f) {
      console.error(`[chase] getMoveFunction returned no signature for ${key}`);
      return undefined;
    }

    if (f.visibility !== "public") {
      setSignature(key, false);
      return false;
    }

    const returns = f.returns ?? [];
    const hasMutable = returns.some((r: any) => r?.reference === "mutable");
    setSignature(key, hasMutable);
    return hasMutable;
  }
}

