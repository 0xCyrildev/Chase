import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const SYSTEM_SENDER = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Sui's own framework packages.
 *
 * Their public data-structure accessors deliberately hand a mutable reference back to the
 * caller (`0x2::dynamic_field::borrow_mut`, `0x2::bag::borrow_mut`, `0x2::table::borrow_mut`,
 * `0x2::object::borrow_object_mut`, …). That is the framework API working as designed, not the
 * `public` vs `public(package)` bug class this detector exists to find, so including them made
 * the detector fire MUTABLE_REFERENCE_RETURNED (severity high -> tier P0 -> ESCALATE) on almost
 * every transaction that touches a dynamic field.
 *
 * This is the exclusion the sibling detectors express as a SYSTEM_MODULES list, widened to whole
 * packages: every entry in those lists lives under 0x1 or 0x2, and a user package can never own
 * those ids, so package-level exclusion cannot hide a user module.
 */
const FRAMEWORK_PACKAGES = new Set([
  // std: vector, option, string, type_name, …
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  // framework: transfer, dynamic_field, dynamic_object_field, bag, table, object, coin, …
  "0x0000000000000000000000000000000000000000000000000000000000000002",
]);

function isFramework(packageId?: string): boolean {
  return !!packageId && FRAMEWORK_PACKAGES.has(packageId);
}

export const mutableAccess: InvariantChecker = {
  name: "mutable-access",
  description:
    "Flags non-framework packages whose entry points hand a mutable reference (&mut) back to the calling " +
    "transaction (the public vs public(package) bug class). The callee package is recorded, together with the " +
    "other non-framework packages invoked in the same PTB, which are the ones that could consume that reference.",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const sender = trace.sender;

    if (!sender || sender === "unknown" || sender === SYSTEM_SENDER) return violations;

    // Every MoveCall in this PTB with a resolvable package: the set of packages the returned
    // reference could be passed on to. Argument wiring is not in the trace, so this is recorded
    // as "packages also invoked by this transaction", not as a proven data-flow edge.
    const moveCalls = trace.ptbCommands.filter((c) => c.kind === "MoveCall" && !!c.packageId);

    for (const cmd of moveCalls) {
      if (!cmd.returnsMutableRef) continue;

      const calleePackage = cmd.packageId!;
      if (isFramework(calleePackage)) continue;

      const otherPackages = [
        ...new Set(
          moveCalls
            .map((c) => c.packageId!)
            .filter((p) => p !== calleePackage && !isFramework(p))
        ),
      ];
      const crossesPackage = otherPackages.length > 0;

      violations.push({
        type: "MUTABLE_REFERENCE_RETURNED",
        severity: "high",
        message: crossesPackage
          ? `${calleePackage}::${cmd.module}::${cmd.function} returns a mutable reference to the transaction, ` +
            `which also calls ${otherPackages.length} other non-framework package(s)`
          : `${calleePackage}::${cmd.module}::${cmd.function} returns a mutable reference to the calling ` +
            `transaction; no other non-framework package is invoked in this PTB`,
        evidence: {
          caller: sender,
          package: calleePackage,
          module: cmd.module,
          function: cmd.function,
          commandIndex: cmd.index,
          calleePackage,
          otherNonFrameworkPackages: otherPackages,
          crossesPackageBoundaryInThisPtb: crossesPackage,
        },
      });
    }

    return violations;
  },
};
