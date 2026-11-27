import type { Headroom, ReadingStamp } from './headroom.js';

/** A reading held while Genie reads who is signed in, given back stamped with the account found. */
export interface HeldReading { readonly room: Headroom; readonly stamp: ReadingStamp }

/**
 * WHOSE READING IT IS, ACROSS A SIGN-IN (Tynn #753; the owner on a fresh account: "I am still seeing 8% remaining"). One home
 * per provider: a sign-in changes the account every running agent uses at once, but Genie learns WHICH account only when its
 * read of who is signed in (`claude auth status`, up to 30 s) has recorded it. A reading stamped with the active account in
 * that gap is the new account's figure under the old account's name, and the board keeps every window a reading does not
 * repeat: a fresh account reports only its 7d window, so the old account's 5h figure stayed on screen as the new one's.
 *
 * So while a provider's identity is being read, its readings are HELD (windows merged, the latest figure of each) and given
 * back when the read ends, stamped with the account then active. The first reading after a sign-in, or after the active
 * account changed, is FRESH: it keeps no earlier window. A read that changed nothing and followed no sign-in changes nothing.
 */
export class ReadingAttribution {
    readonly #signedIn = new Set<string>();
    readonly #reading = new Map<string, { activeAtStart: string; depth: number; held: HeldReading | null }>();
    readonly #freshNext = new Set<string>();

    /** The provider's login just ended signed in: the account its next readings come from may not be the one Genie knows. */
    signedIn(provider: string): void {
        this.#signedIn.add(provider);
    }

    /** A read of who is signed in to the provider started; `activeId` is the account active now. */
    readStart(provider: string, activeId: string): void {
        const r = this.#reading.get(provider);
        if (r) r.depth += 1;
        else this.#reading.set(provider, { activeAtStart: activeId, depth: 1, held: null });
    }

    /** The stamp to show a reading under now, or `null` when it is held until the read of who is signed in ends. */
    stamp(provider: string, room: Headroom, stamp: ReadingStamp): ReadingStamp | null {
        // A run in its own account's directory: whoever is signed in by default, the reading is that account's (#1011).
        if (stamp.pinned) return stamp;
        const r = this.#reading.get(provider);
        if (r) {
            const named = new Set(room.windows.map((w) => w.window));
            const kept = r.held ? r.held.room.windows.filter((w) => !named.has(w.window)) : [];
            r.held = { room: kept.length === 0 ? room : { ...room, windows: [...room.windows, ...kept] }, stamp };
            return null;
        }
        if (this.#freshNext.delete(provider)) return { ...stamp, fresh: true };
        return stamp;
    }

    /**
     * The read ended; `activeId` is the account active now. `changed`: the active account is another one (the window re-reads
     * its accounts). `held`: the reading that arrived meanwhile, stamped with that account, to show now.
     */
    readEnd(provider: string, activeId: string): { readonly changed: boolean; readonly held: HeldReading | null } {
        const r = this.#reading.get(provider);
        if (!r) return { changed: false, held: null };
        if (--r.depth > 0) return { changed: false, held: null };
        this.#reading.delete(provider);
        const changed = r.activeAtStart !== activeId;
        const fresh = this.#signedIn.delete(provider) || changed;
        if (r.held) return { changed, held: { room: r.held.room, stamp: { accountId: activeId, runId: r.held.stamp.runId, ...(fresh ? { fresh: true } : {}) } } };
        if (fresh) this.#freshNext.add(provider);
        return { changed, held: null };
    }
}
