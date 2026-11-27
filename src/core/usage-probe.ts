import type { AccountRecord } from './accounts.js';
import type { Headroom } from './headroom.js';

/** A reading of an account younger than this needs no probe; and no account is probed twice in it (Tynn #1084). */
export const PROBE_STALE_MS = 15 * 60_000;
/** While the Accounts panel stays open, it asks again this often (under the same rules). */
export const PANEL_RECHECK_MS = 5 * 60_000;

/** An account's probe as the panel shows it: being read now, or why the last read failed. `null`: nothing to say. */
export type UsageProbeState = { readonly state: 'reading' } | { readonly state: 'failed'; readonly reason: string; readonly at: number };

export interface UsageProbePorts {
    /**
     * THE ONE READ (Tynn #1084): the account's own limits, as its provider reports them. Today a one-turn probe in its folder
     * (main/claude-usage-read.ts); prism-acp's own read when it has one, with nothing else here changing.
     */
    readonly read: (account: AccountRecord) => Promise<Headroom>;
    /**
     * Why this account cannot be read here now (the default home is signed in to another), or `null` when it can. It may ask
     * Claude Code afresh (a live state not read yet must not refuse the account the person is signed in to).
     */
    readonly canRead: (account: AccountRecord) => string | null | Promise<string | null>;
    /** When the account's last reading was shown (a real run's or a probe's), or `null` when it has none. */
    readonly lastReadingAt: (accountId: string) => number | null;
    /** The reading, offered under THAT account (never another's, #1070). */
    readonly offer: (account: AccountRecord, room: Headroom) => void;
    /** Something the panel shows changed. */
    readonly changed: () => void;
    readonly now: () => number;
}

export type UsageProbeOutcome = 'read' | 'skipped' | 'failed';

/**
 * WHEN AN ACCOUNT'S USAGE IS ASKED FOR (Tynn #1084). Claude reports an account's limits only in a turn, so an account no agent
 * has run on since a switch was never read ("Usage unknown: not read yet", for good). The triggers (a switch, an account's
 * first use, the Accounts panel opening and every 5 min while it stays open) all come here, and the rules are one:
 *  - an account with a reading of its own in the last 15 min is not asked (a real run keeps it fresh);
 *  - no account is asked twice in 15 min, whichever triggers asked and whether the last read worked;
 *  - one read at a time per account: triggers that arrive together share it.
 * "Check usage now" (`manual`) asks at once, whatever the 15-min rules say; it still shares a read under way.
 */
export class UsageProbes {
    readonly #p: UsageProbePorts;
    readonly #running = new Map<string, Promise<UsageProbeOutcome>>();
    readonly #askedAt = new Map<string, number>();
    readonly #failed = new Map<string, { reason: string; at: number }>();

    constructor(ports: UsageProbePorts) { this.#p = ports; }

    request(account: AccountRecord, options: { readonly manual?: boolean } = {}): Promise<UsageProbeOutcome> {
        if (account.provider !== 'claude') return Promise.resolve('skipped');
        const under = this.#running.get(account.id);
        if (under) return under;
        const now = this.#p.now();
        if (options.manual !== true) {
            const last = this.#p.lastReadingAt(account.id);
            if (last !== null && now - last < PROBE_STALE_MS) return Promise.resolve('skipped');
            const asked = this.#askedAt.get(account.id);
            if (asked !== undefined && now - asked < PROBE_STALE_MS) return Promise.resolve('skipped');
        }
        this.#askedAt.set(account.id, now);
        const run = this.#read(account).finally(() => { this.#running.delete(account.id); this.#p.changed(); });
        this.#running.set(account.id, run);
        this.#p.changed();
        return run;
    }

    async #read(account: AccountRecord): Promise<UsageProbeOutcome> {
        try {
            const refused = await this.#p.canRead(account);
            if (refused !== null) { this.#failed.set(account.id, { reason: refused, at: this.#p.now() }); return 'failed'; }
            const room = await this.#p.read(account);
            this.#failed.delete(account.id);
            this.#p.offer(account, room);
            return 'read';
        } catch (error) {
            this.#failed.set(account.id, { reason: error instanceof Error ? error.message : String(error), at: this.#p.now() });
            return 'failed';
        }
    }

    state(accountId: string): UsageProbeState | null {
        if (this.#running.has(accountId)) return { state: 'reading' };
        const failed = this.#failed.get(accountId);
        return failed ? { state: 'failed', reason: failed.reason, at: failed.at } : null;
    }

    /** Every account with something to show, for the panel. */
    states(): Readonly<Record<string, UsageProbeState>> {
        const out: Record<string, UsageProbeState> = {};
        for (const id of new Set([...this.#running.keys(), ...this.#failed.keys()])) { const s = this.state(id); if (s) out[id] = s; }
        return out;
    }

    /** A forgotten account leaves (Tynn #484). */
    forget(accountId: string): void { this.#askedAt.delete(accountId); this.#failed.delete(accountId); }
}
