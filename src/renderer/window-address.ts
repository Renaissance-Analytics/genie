import { addressOf, isInternalRoute, rehomeAddress, routeOfAddress, type AddressContext } from '../core/address.js';
import { DEFAULT_ROUTE } from '../core/route.js';

/**
 * WHICH GENIE A WINDOW READS, AND WHERE ITS ADDRESS POINTS (Tynn #529 part A; the release pair run, check 3).
 *
 * A window BOUND to another host (a Tynn workstation's or a known host's window, a Take Over window for another machine)
 * reads that host's Genie once it is connected, and NOTHING of this machine's before: no bridge, so no snapshot, so no
 * address context. Before, it read this machine's snapshot while connecting and rewrote its address to this machine's
 * name (`genie://<pilot>/takeover/<id>`); connected, the drone read that address as nothing and showed its Dashboard.
 * A window not bound to a host reads this machine's Genie, or the host it connects to in place.
 */
export function windowBridge<B>(input: { bound: string | null; connected: boolean; remote: B | null; local: B | undefined }): B | undefined {
    if (input.connected && input.remote !== null) return input.remote;
    return input.bound !== null ? undefined : input.local;
}

/** The window's route from its address: by the context it reads; with none yet, an internal route as it is. */
export function routeFor(address: string, ctx: AddressContext | null): string {
    return ctx ? routeOfAddress(address, ctx) ?? DEFAULT_ROUTE : isInternalRoute(address) ? address : DEFAULT_ROUTE;
}

/**
 * An internal route (an old address, a route main opened) rewritten to the machine's address form; `null` = leave it.
 * `before`: the workstation this window read until now. A window that now reads ANOTHER (it connected in place, beta.61
 * step four) takes its page there: `genie://<pilot>/settings/remote` → `genie://<drone>/settings/remote`. Read against the
 * new machine the old name is nothing, and the window fell to that machine's Dashboard.
 */
export function rewrittenAddress(address: string, ctx: AddressContext | null, before: string | null = null): string | null {
    if (!ctx) return null;
    if (before !== null && before.toLowerCase() !== ctx.workstation.toLowerCase()) {
        const moved = rehomeAddress(address, before, ctx.workstation);
        if (moved !== address && routeOfAddress(moved, ctx) !== null) return moved;
    }
    const shown = addressOf(routeFor(address, ctx), ctx);
    return shown === address || !isInternalRoute(address) ? null : shown;
}
