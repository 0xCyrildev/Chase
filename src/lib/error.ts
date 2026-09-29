/**
 * A CLI should explain bad input rather than dump a call stack. `CHASE_DEBUG=1` brings the stack back
 * for anyone who actually needs it.
 */
export function reportError(label: string, err: unknown): void {
  const e = err as any;
  console.error(`${label} ${e?.message ?? String(err)}`);
  if (process.env.CHASE_DEBUG === "1" && typeof e?.stack === "string") {
    console.error(e.stack);
  }
}
