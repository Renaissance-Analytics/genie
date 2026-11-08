import { addressOf, isInternalRoute, routeOfAddress, type AddressContext } from '../core/address.js';
import { DEFAULT_ROUTE } from '../core/route.js';

/**
 * RED-RUN STUB (Tynn #529 part A, the pair run's check 3): App's own rules, moved here unchanged so the test can drive them.
 * The next commit fixes which bridge a window bound to another host reads.
 */
export function windowBridge<B>(input: { bound: string | null; connected: boolean; remote: B | null; local: B | undefined }): B | undefined {
    return input.connected && input.remote !== null ? input.remote : input.local;
}

export function routeFor(address: string, ctx: AddressContext | null): string {
    return ctx ? routeOfAddress(address, ctx) ?? DEFAULT_ROUTE : isInternalRoute(address) ? address : DEFAULT_ROUTE;
}

export function rewrittenAddress(address: string, ctx: AddressContext | null): string | null {
    if (!ctx) return null;
    const shown = addressOf(routeFor(address, ctx), ctx);
    return shown === address || !isInternalRoute(address) ? null : shown;
}
