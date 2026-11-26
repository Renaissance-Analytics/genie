import type { HostSummary } from '../core/host-summary.js';
import { keychainBecameReady } from '../core/host-summary.js';
import { removeOldCopies, stuckLines, type MigrationOutcome, type MigrationSource, type MigrationStatus, type OldRead } from './keychain-migration.js';
import type { SecretName } from './keychain.js';
import { holdSources } from './migration-holds.js';
import { callRefusal, type OwnCallAnswer } from './own-protocol-client.js';
import type { LegacyIdentity } from './workstation-identity.js';

/**
 * THE WINDOW'S ONE-SHOT UNSEALER (Tynn #959, client/host split step 2g-3b; the coordinator's ruling). Electron's safeStorage
 * opens what an older Genie sealed, and only the window has Electron, so the window does that and nothing else: it finds the
 * old copies (the agents' keys in agents.json, the Tynn pairing, GitHub's tokens, this machine's workstation key) and Genie 1's
 * record of this machine, unseals each once, and hands them to genie-host on `keychain.adoptLegacy`. genie-host writes them to
 * ITS keychain, reads them back and books them (host-legacy-adopt.ts); this deletes exactly the old copies genie-host names,
 * then says so (phase `removed`), and genie-host writes `done`.
 *
 * It keeps NO secret and no store: what it read goes out in the one call and is dropped. It says names and states, never a
 * value. It runs at boot, and again whenever genie-host's summary says its keychain became able to keep secrets
 * (`keychainReady`), never more than once at a time.
 *
 * Per the owner's split ruling ("Electron pieces live in the launcher"), this unsealer moves to the launcher in split step 6.
 */
export interface LegacyUnsealerPorts {
    /** The old copies as the window finds them (keychain-migration.ts gatherSources: a group that fails answers under its file). */
    readonly sources: () => Promise<readonly MigrationSource[]>;
    /** Genie 1's record of this machine, its key unsealed when this Genie can; null = none. */
    readonly genie1Identity: () => Promise<LegacyIdentity | null>;
    /** main's own protocol client (own-protocol-client.ts). */
    readonly call: (method: 'keychain.adoptLegacy', args: unknown[]) => Promise<OwnCallAnswer>;
    /** Names and states only. */
    readonly log: (line: string) => void;
    /** For the test build's holds (migration-holds.ts). */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface LegacyUnsealer {
    /** One pass. Asked while one runs, it runs once more after it, never alongside. */
    run(): Promise<void>;
    /** Every summary genie-host pushes: the keychain turning ready runs it again. */
    summary(before: HostSummary, after: HostSummary): void;
}

const STATUSES: ReadonlySet<string> = new Set<MigrationStatus>(['moved', 'nothing', 'already', 'verified', 'keychain-unavailable', 'read-back-differs', 'keychain-differs', 'too-large', 'old-copy-unreadable', 'confirmed-entry-missing', 'old-copy-left', 'not-confirmed', 'book-failed']);

/** genie-host's answer as it came back: statuses by name, and what may be deleted. Anything else deletes nothing. */
function answerOf(raw: unknown): { outcomes: MigrationOutcome[]; remove: string[] } | null {
    const r = raw as { outcomes?: unknown; remove?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.outcomes) || !Array.isArray(r.remove)) return null;
    const outcomes: MigrationOutcome[] = [];
    for (const o of r.outcomes as unknown[]) {
        const v = o as { name?: unknown; status?: unknown } | null;
        if (!v || typeof v.name !== 'string' || typeof v.status !== 'string' || !STATUSES.has(v.status)) return null;
        outcomes.push({ name: v.name as SecretName, status: v.status as MigrationStatus });
    }
    if (!(r.remove as unknown[]).every((n) => typeof n === 'string')) return null;
    return { outcomes, remove: [...(r.remove as string[])] };
}

const UNREADABLE: OldRead = { kind: 'unreadable' };

export function legacyUnsealer(ports: LegacyUnsealerPorts): LegacyUnsealer {
    /** Each name and reason said once per launch (keychain-migration.ts stuckLines). */
    const said = new Set<string>();
    const once = async (): Promise<void> => {
        let sources: readonly MigrationSource[];
        try {
            sources = holdSources(await ports.sources(), ports.env);
        } catch {
            // Its words stay out: they may say what was in a file.
            ports.log('[keychain] the old copies could not be gathered; nothing moves this time');
            return;
        }
        // Unsealed here, once; sent in the one call below, and dropped with this pass.
        const secrets: { name: string; read: { kind: 'value'; value: string } | { kind: 'none' } | { kind: 'unreadable'; covers?: string } }[] = [];
        for (const source of sources) {
            const read = await source.old.read().catch(() => UNREADABLE);
            secrets.push({ name: source.name, read: read.kind === 'unreadable' ? { kind: 'unreadable', ...(source.covers !== undefined ? { covers: source.covers } : {}) } : read });
        }
        const genie1Identity = await ports.genie1Identity().catch(() => null);
        const adopted = await ports.call('keychain.adoptLegacy', [{ phase: 'adopt', secrets, genie1Identity }]);
        const refused = callRefusal(adopted);
        const answer = refused === null && adopted.ok ? answerOf(adopted.value) : null;
        if (!answer) {
            ports.log(`[keychain] genie-host did not take the old copies (${refused ?? 'its answer did not read'}); nothing was deleted`);
            return;
        }
        // Exactly what genie-host named, and only those it answered `verified` for.
        const named = new Set(answer.remove);
        const deletable = answer.outcomes.filter((o) => o.status === 'verified' && named.has(o.name));
        const kept = answer.outcomes.filter((o) => !(o.status === 'verified' && named.has(o.name)));
        const { removed, outcomes: deleted } = await removeOldCopies(sources, deletable);
        let finished: MigrationOutcome[] = [];
        if (removed.length > 0) {
            const done = await ports.call('keychain.adoptLegacy', [{ phase: 'removed', names: removed }]);
            const doneRefused = callRefusal(done);
            const doneAnswer = doneRefused === null && done.ok ? answerOf(done.value) : null;
            // Not heard: the old copies are gone and the book still says `verified`, which the next run finishes.
            if (!doneAnswer) ports.log(`[keychain] genie-host was not told the old copies are gone (${doneRefused ?? 'its answer did not read'}); the next run finishes them`);
            finished = doneAnswer?.outcomes ?? [];
        }
        const final = [...kept, ...deleted.map((o) => finished.find((f) => f.name === o.name) ?? o)];
        for (const line of stuckLines(final, said)) ports.log(line);
    };
    let running: Promise<void> | null = null;
    let again = false;
    const run = (): Promise<void> => {
        if (running) { again = true; return running; }
        running = (async () => {
            do {
                again = false;
                await once().catch(() => { ports.log('[keychain] the old copies could not be handed over this time'); });
            } while (again);
        })().finally(() => { running = null; });
        return running;
    };
    return {
        run,
        summary: (before, after) => { if (keychainBecameReady(before, after)) void run(); },
    };
}
