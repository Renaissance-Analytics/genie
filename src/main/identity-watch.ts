import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import type { Headroom, ReadingStamp } from '../core/headroom.js';
import type { ReadingAttribution } from '../core/reading-attribution.js';
import type { IdentityReadHooks } from './account-identity.js';

/**
 * NOTICING A SIGN-IN DONE OUTSIDE GENIE (Tynn #854; the owner switched with /login in a TUI and Genie did not notice). Who is
 * signed in was read only at start, after Genie's own login or switch terminal, and on a health re-measure, so a /login typed
 * anywhere else left the chip, the popover and the Dashboard on the old account. A sign-in elsewhere leaves Genie no event of
 * its own, so it asks again, the provider's own way (AccountIdentityReader: `claude auth status`, Codex `account/read`; no
 * credential file is opened, here or there):
 *
 * - when a usage reading arrives and the provider's identity was not read in the last minute. The read starts BEFORE the
 *   reading is stamped, so ReadingAttribution holds it and gives it back under the account actually signed in: the first
 *   reading after an outside switch is the new account's, never the old one's figure;
 * - as an idle backstop (the host ticks this every minute): a provider not read for five minutes is read again, for a switch
 *   made while no agent is working.
 *
 * Any read starts the clock again, Genie's own included (`read`, from the reader's start hook). A changed account tells the
 * windows (identityReadHooks → accounts-changed), which re-read their account chips.
 */
export const IDENTITY_AFTER_READING_MS = 60_000;
export const IDENTITY_IDLE_MS = 5 * 60_000;

export interface IdentityWatchPorts {
    /** Read who is signed in to the provider, and record it (AccountIdentityReader.refreshProvider). */
    readonly refresh: (provider: AcpProvider) => Promise<void>;
    readonly now: () => number;
}

export class IdentityWatch {
    readonly #p: IdentityWatchPorts;
    /** When each provider's identity was last asked for. */
    readonly #last = new Map<AcpProvider, number>();

    constructor(ports: IdentityWatchPorts) { this.#p = ports; }

    /** A read of who is signed in started (any read: Genie's own, or one this watch asked for). */
    read(provider: AcpProvider): void { this.#last.set(provider, this.#p.now()); }

    /** A usage reading arrived from the provider: ask again when no read was made in the last minute. */
    reading(provider: string): void {
        if (isAcpProvider(provider) && this.#due(provider, IDENTITY_AFTER_READING_MS)) this.#ask(provider);
    }

    /** The idle backstop: every provider not read for five minutes is read again. */
    tick(): void {
        for (const provider of ACP_PROVIDERS) if (this.#due(provider, IDENTITY_IDLE_MS)) this.#ask(provider);
    }

    #due(provider: AcpProvider, gapMs: number): boolean {
        const last = this.#last.get(provider);
        return last === undefined || this.#p.now() - last >= gapMs;
    }

    #ask(provider: AcpProvider): void {
        this.#last.set(provider, this.#p.now());
        void this.#p.refresh(provider).catch(() => undefined);
    }
}

type Offer = (provider: string, room: Headroom, stamp?: ReadingStamp) => void;

/** The reader's hooks: readings are held while who is signed in is read, then given back under the account found. */
export function identityReadHooks(p: {
    readonly attribution: ReadingAttribution;
    readonly activeId: (provider: AcpProvider) => string;
    readonly offer: Offer;
    readonly changed: () => void;
    /** A read started: the watch's clock starts again. */
    readonly read: (provider: AcpProvider) => void;
}): IdentityReadHooks {
    return {
        readStart: (provider) => { p.read(provider); p.attribution.readStart(provider, p.activeId(provider)); },
        readEnd: (provider) => {
            const ended = p.attribution.readEnd(provider, p.activeId(provider));
            if (ended.held) p.offer(provider, ended.held.room, ended.held.stamp);
            if (ended.changed) p.changed();
        },
    };
}

/**
 * A usage reading from an agent's run. A stamped one may first ask who is signed in (the watch); a read under way holds it
 * (ReadingAttribution), so it is shown under the account found. Unstamped readings are shown as they came.
 */
export function headroomArrival(p: { readonly watch: IdentityWatch; readonly attribution: ReadingAttribution; readonly offer: Offer }): (provider: string, room: Headroom, stamp?: ReadingStamp) => void {
    return (provider, room, stamp) => {
        if (!stamp) { p.offer(provider, room, stamp); return; }
        p.watch.reading(provider);
        const shown = p.attribution.stamp(provider, room, stamp);
        if (shown) p.offer(provider, room, shown);
    };
}
