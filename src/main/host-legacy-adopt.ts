import type { SecretName } from './keychain.js';
import { finishSecrets, verifySecrets, type HostVault, type MigrationBook, type MigrationOutcome, type OldRead, type VerifySource } from './keychain-migration.js';
import { holdHostPorts } from './migration-holds.js';
import type { LegacyIdentity } from './workstation-identity.js';

/**
 * GENIE-HOST ADOPTS WHAT AN OLDER GENIE SEALED (Tynn #959, client/host split step 2g-3b; the coordinator's ruling). Only Electron
 * can open those seals, so the window unseals each old copy once and hands it over on `keychain.adoptLegacy` (local only, and
 * only from this machine's own Genie: host-api.ts). Here the move runs as it always has (keychain-migration.ts), against THIS
 * host's keychain and the same book (`<genieHome>/keychain-migration.json`, so a book an older Genie wrote is honoured):
 *
 *   phase `adopt`:   the window's reads -> write -> read back -> `verified` -> answer the names the window may delete now
 *   phase `removed`: the window deleted those -> `done`
 *
 * Nothing here deletes anything: genie-host cannot reach the window's files, and `done` waits for the window to say its copy is
 * gone, so a crash between the phases leaves the old copy deletable on the next run. What it answers is names and statuses in
 * words, never a value. Something moved (or Genie 1's record came with it): this host reads its accounts again, registers
 * the workstation with Genie 1's record, and brings its agents back to Tynn, by itself (`moved`).
 */
export type AdoptRead = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'none' } | { readonly kind: 'unreadable'; readonly covers?: string };
export interface AdoptSecret { readonly name: string; readonly read: AdoptRead }
export type AdoptRequest =
    | { readonly phase: 'adopt'; readonly secrets: readonly AdoptSecret[]; readonly genie1Identity: LegacyIdentity | null }
    | { readonly phase: 'removed'; readonly names: readonly string[] };
/** The answer, in words: each secret's status, and the old copies the window may delete now. No value is ever in it. */
export interface AdoptAnswer {
    readonly outcomes: readonly MigrationOutcome[];
    readonly remove: readonly SecretName[];
}
export type AdoptRefusal = { readonly ok: false; readonly reason: string };

/** The most one request may name: far more than a person has, few enough to answer at once. */
const MAX_SECRETS = 1000;
const MAX_NAME = 300;
const AGENT_KEY = /^tynn\/agent\/[0-9A-HJKMNP-TV-Z]{26}$/i;

/** What an older Genie sealed, by name: the only secrets this method ever writes. A device's, an inbox's or a deploy's never came from a seal. */
export function movableSecret(name: string): name is SecretName {
    if (name === 'tynn/pairing' || name === 'github/access' || name === 'github/refresh') return true;
    if (name.startsWith('workstation/')) return name.length > 'workstation/'.length && name.length <= MAX_NAME;
    return AGENT_KEY.test(name);
}

const refuse = (reason: string): AdoptRefusal => ({ ok: false, reason });

function readOf(raw: unknown): AdoptRead | null {
    const r = raw as { kind?: unknown; value?: unknown; covers?: unknown } | null;
    if (!r || typeof r !== 'object') return null;
    if (r.kind === 'none') return { kind: 'none' };
    if (r.kind === 'value') return typeof r.value === 'string' ? { kind: 'value', value: r.value } : null;
    if (r.kind === 'unreadable') {
        if (r.covers !== undefined && (typeof r.covers !== 'string' || r.covers.length > MAX_NAME)) return null;
        return typeof r.covers === 'string' ? { kind: 'unreadable', covers: r.covers } : { kind: 'unreadable' };
    }
    return null;
}

function identityOf(raw: unknown): LegacyIdentity | null | undefined {
    if (raw === null || raw === undefined) return null;
    const r = raw as { workstationId?: unknown; privateKeyPem?: unknown };
    if (typeof r !== 'object' || typeof r.workstationId !== 'string' || r.workstationId.trim() === '' || r.workstationId.length > MAX_NAME) return undefined;
    if (r.privateKeyPem !== null && typeof r.privateKeyPem !== 'string') return undefined;
    return { workstationId: r.workstationId, privateKeyPem: r.privateKeyPem };
}

/**
 * The request as it came over the wire, or why it is refused. Its words never quote what was sent: a value, or Genie 1's key,
 * may be in it.
 */
export function readAdoptRequest(raw: unknown): AdoptRequest | AdoptRefusal {
    const r = raw as { phase?: unknown; secrets?: unknown; names?: unknown; genie1Identity?: unknown } | null;
    if (!r || typeof r !== 'object') return refuse('keychain.adoptLegacy takes one request');
    if (r.phase === 'removed') {
        if (!Array.isArray(r.names) || r.names.length > MAX_SECRETS || !r.names.every((n) => typeof n === 'string' && movableSecret(n))) return refuse('keychain.adoptLegacy: the removed old copies are named by the secrets they held');
        return { phase: 'removed', names: [...r.names] as string[] };
    }
    if (r.phase !== 'adopt') return refuse('keychain.adoptLegacy has two phases: adopt and removed');
    if (!Array.isArray(r.secrets) || r.secrets.length > MAX_SECRETS) return refuse('keychain.adoptLegacy: the old copies come as a list');
    const secrets: AdoptSecret[] = [];
    for (const entry of r.secrets as unknown[]) {
        const e = entry as { name?: unknown; read?: unknown } | null;
        if (!e || typeof e !== 'object' || typeof e.name !== 'string' || e.name === '' || e.name.length > MAX_NAME) return refuse('keychain.adoptLegacy: an old copy is named');
        const read = readOf(e.read);
        if (!read) return refuse(`keychain.adoptLegacy: ${movableSecret(e.name) ? e.name : 'an old copy'} came with no read`);
        // A file that could not be read answers under the file's own name; anything else is one of the secrets a seal held.
        if (read.kind !== 'unreadable' && !movableSecret(e.name)) return refuse('keychain.adoptLegacy takes only the secrets an older Genie sealed');
        secrets.push({ name: e.name, read });
    }
    const genie1Identity = identityOf(r.genie1Identity);
    if (genie1Identity === undefined) return refuse('keychain.adoptLegacy: Genie 1’s record of this machine did not read');
    return { phase: 'adopt', secrets, genie1Identity };
}

/** What main read, as the engine's source: its read answers what was sent, and it has nothing to delete. */
function sourceOf(secret: AdoptSecret): VerifySource {
    const answer: OldRead = secret.read.kind === 'unreadable' ? { kind: 'unreadable' } : secret.read;
    return {
        name: secret.name as SecretName,
        old: { read: async () => answer },
        ...(secret.read.kind === 'unreadable' && secret.read.covers !== undefined ? { covers: secret.read.covers } : {}),
    };
}

export interface HostLegacyAdoptPorts {
    /** This host's keychain (keychain-migration.ts hostVault). */
    readonly vault: HostVault;
    /** The ONE book (fileMigrationBook over `<genieHome>/keychain-migration.json`), built once: its two halves run one at a time. */
    readonly book: MigrationBook;
    /** Names and statuses only. */
    readonly log: (line: string) => void;
    /**
     * After an `adopt` that moved something (`secretsMoved`), or that brought Genie 1's record: reload the accounts, register
     * the workstation with the record, bring the agents back to Tynn. Never told a value.
     */
    readonly moved: (what: { readonly secretsMoved: boolean; readonly genie1Identity: LegacyIdentity | null }) => void;
    /** For the test build's holds (migration-holds.ts). */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Moved or confirmed: the keychain's copy is the one in use now, so whoever reads it reads again. */
const MOVED: ReadonlySet<string> = new Set(['verified', 'moved']);

export function hostLegacyAdopt(ports: HostLegacyAdoptPorts): { adopt(raw: unknown): Promise<AdoptAnswer | AdoptRefusal> } {
    // Wrapped once, so the one book stays one book: the engine runs its halves one at a time per book.
    const { vault, book } = holdHostPorts({ vault: ports.vault, book: ports.book }, ports.env);
    const say = (outcomes: readonly MigrationOutcome[]) => {
        // An `already` is every launch's word for every secret: not said.
        for (const { name, status } of outcomes) if (status !== 'already') ports.log(`keychain: ${name}: ${status}`);
    };
    return {
        adopt: async (raw) => {
            const request = readAdoptRequest(raw);
            if ('ok' in request) return request;
            if (request.phase === 'removed') {
                const outcomes = await finishSecrets(request.names as SecretName[], book);
                say(outcomes);
                return { outcomes, remove: [] };
            }
            const outcomes = await verifySecrets(request.secrets.map(sourceOf), vault, book);
            say(outcomes);
            const secretsMoved = outcomes.some((o) => MOVED.has(o.status));
            if (secretsMoved || request.genie1Identity !== null) ports.moved({ secretsMoved, genie1Identity: request.genie1Identity });
            return { outcomes, remove: outcomes.filter((o) => o.status === 'verified').map((o) => o.name) };
        },
    };
}
