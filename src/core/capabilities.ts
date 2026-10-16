/**
 * WHAT A DRIVER DECLARES IT CAN DO.
 *
 * ## Branch on the declaration, never on a provider name
 *
 * Guidance from the author of `prism-acp`, 2026-10-10, and it saves real work: a Claude
 * permission bridge is specced (`permissionRequests` false → true on `ClaudeDriver` only)
 * but **not started and carries no date**. Code that branches on the string `'claude'` has
 * to change when that lands. Code that branches on the declaration does not.
 *
 * The previous build made exactly this mistake in the other direction — it derived a
 * provider's abilities from a hard-coded list in the renderer, which went stale twice.
 *
 * ## Absence is not denial
 *
 * `undefined` means *the driver did not say*. It does not mean *no*. Collapsing the two
 * would hide a real capability behind a confident denial we have no basis for — the same
 * defect as rendering `0` for a number we cannot see, which is §5 of the spec and the most
 * expensive class of mistake this product makes.
 *
 * So capability is three-state, and the UI consequence follows from it:
 *
 * | Value | Means | The UI may |
 * |---|---|---|
 * | `true` | declared supported | use it |
 * | `false` | declared unsupported | **say so** — a stated fact, e.g. *"claude never asks Genie for permission"* |
 * | `null` | did not declare | **render nothing.** Not a denial, not a dash, not a greyed control |
 */
export type Capability = boolean | null;

/**
 * Where `prism-acp` puts driver capabilities.
 *
 * Deliberately in `_meta` and **not** on `agentCapabilities` — the package has a test
 * pinning that it is not leaked there, so this is the one place to read it from.
 */
export const CAPABILITY_META_KEY = 'particle.academy/driver_capabilities';

/** The capabilities Genie currently reads. Extend only when a driver really declares one. */
export type CapabilityName = 'permissionRequests' | 'transcriptReplay';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one capability from a frame's `_meta`.
 *
 * Returns `null` for every shape that is not an explicit boolean — absent meta, absent key,
 * a malformed block, or a non-boolean value. **A string `'false'` is not a declaration of
 * `false`**; it is a driver we do not understand, which is an unknown.
 */
export function capabilityOf(meta: Record<string, unknown> | undefined | null, name: CapabilityName): Capability {
    if (!isRecord(meta)) return null;

    const block = meta[CAPABILITY_META_KEY];
    if (!isRecord(block)) return null;

    const value = block[name];
    return typeof value === 'boolean' ? value : null;
}

/**
 * How the UI is allowed to describe a capability — or `null` meaning **say nothing**.
 *
 * The caller must handle `null` by rendering no element at all, rather than an empty one. A
 * section that can never populate is not drawn; absence of a control, never a disabled one.
 */
export function describeCapability(value: Capability): string | null {
    if (value === true) return 'supported';
    if (value === false) return 'not supported';
    return null;
}
