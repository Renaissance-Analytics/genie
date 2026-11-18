import type { AcpProvider } from '../core/engine.js';
import type { Headroom, ReadingStamp } from '../core/headroom.js';
import type { ReadingAttribution } from '../core/reading-attribution.js';
import type { IdentityReadHooks } from './account-identity.js';

/**
 * NOTICING A SIGN-IN DONE OUTSIDE GENIE (Tynn #854). RED stage: today's composition, extracted unchanged.
 */
export const IDENTITY_AFTER_READING_MS = 60_000;
export const IDENTITY_IDLE_MS = 5 * 60_000;

export interface IdentityWatchPorts {
    readonly refresh: (provider: AcpProvider) => Promise<void>;
    readonly now: () => number;
}

export class IdentityWatch {
    constructor(_ports: IdentityWatchPorts) {}
    read(_provider: AcpProvider): void {}
    reading(_provider: string): void {}
    tick(): void {}
}

type Offer = (provider: string, room: Headroom, stamp?: ReadingStamp) => void;

/** The reader's hooks: readings are held while who is signed in is read, then given back under the account found. */
export function identityReadHooks(p: {
    readonly attribution: ReadingAttribution;
    readonly activeId: (provider: AcpProvider) => string;
    readonly offer: Offer;
    readonly changed: () => void;
    readonly read: (provider: AcpProvider) => void;
}): IdentityReadHooks {
    return {
        readStart: (provider) => { p.attribution.readStart(provider, p.activeId(provider)); },
        readEnd: (provider) => {
            const ended = p.attribution.readEnd(provider, p.activeId(provider));
            if (ended.held) p.offer(provider, ended.held.room, ended.held.stamp);
            if (ended.changed) p.changed();
        },
    };
}

/** A usage reading from an agent's run: stamped with whose it is (held while a read is under way), then shown. */
export function headroomArrival(p: { readonly watch: IdentityWatch; readonly attribution: ReadingAttribution; readonly offer: Offer }): (provider: string, room: Headroom, stamp?: ReadingStamp) => void {
    return (provider, room, stamp) => {
        if (!stamp) { p.offer(provider, room, stamp); return; }
        const shown = p.attribution.stamp(provider, room, stamp);
        if (shown) p.offer(provider, room, shown);
    };
}
