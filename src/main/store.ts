import { renameOver } from '../core/atomic-rename.js';
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_RECORD_FIELDS, asAgentId, withoutAgentAccount, type AgentRecord } from '../core/identity.js';
import { isOsAgent } from '../core/os-agent.js';
import { runtimeDir } from './paths.js';
import { restrictPrivateFile } from './private-credentials.js';

/**
 * WHAT GENIE REMEMBERS BETWEEN RUNS — workspaces and agent records.
 *
 * Two small JSON files under the runtime directory (never the install directory — see
 * `paths.ts`). Deliberately not a database: this is a list of workspaces and a list of agent
 * identities, it is read once at boot, and `better-sqlite3` would be a native dependency with
 * no Fancy equivalent bought for nothing.
 *
 * ## Every write is atomic
 *
 * Write to `<file>.tmp`, then `rename` over the target. A direct write that is interrupted —
 * a crash, a power cut, an upgrade killing the process mid-flush — leaves a truncated JSON
 * file, and on next boot Genie has lost **every agent identity it ever had**: the persona
 * files survive, the records that point at threads do not. `rename` within a directory is
 * atomic on both NTFS and POSIX, so the file is either the old one or the new one.
 *
 * ## A missing file and an unreadable file are different
 *
 * A missing file is a first run and reads as empty. **An unreadable or malformed one throws**,
 * because that is data loss in progress and silently continuing with `[]` would then persist
 * the emptiness over whatever was there — turning a recoverable corrupt file into a real
 * deletion on the very next save.
 */

export interface WorkspaceRecord {
    id: string;
    path: string;
    /** Hibernated (§6.1): nothing may start here; stays asleep through restarts and upgrades. */
    asleep?: boolean;
    /** Last awake display name; ghost labels and old inbox addresses never reopen the folder. */
    hibernatedName?: string;
    /** Ops project (§6.1): the workspace ids this one GOVERNS. A Genie-side relation; the envelope schema has no such field. */
    governs?: string[];
    /** Its DEFAULT AGENT (Genie 1's): one of its own agents, the one an action uses when it names none. Absent = none. */
    defaultAgentId?: string;
    /**
     * The default was given AUTOMATICALLY (Tynn #1015, the owner: "the first or only agent in a workspace is automatically
     * the default agent"), not chosen. A chosen one (the person, project.json on adopt or restore, Genie 1's import)
     * replaces it; nothing automatic replaces a chosen one. Absent = chosen (or none).
     */
    defaultAgentAuto?: true;
    /** MCP servers off by default for every agent here (Tynn #628); an agent's own switch wins. Absent = none. */
    mcpOff?: string[];
    /**
     * Its ENV FILE (Genie 1's `env_file`): the file in each site folder Genie writes the service connection to. Stamped at
     * register from Settings → General "Env file name" (`default_env_file`), so changing the setting later changes new
     * workspaces only, as in Genie 1. Absent (a workspace registered before it existed) = `.env`.
     */
    envFile?: string;
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch (error) {
        // ENOENT is a first run. Anything else — a permission error, a directory where a file
        // should be — is reported, because treating it as empty would overwrite real data on
        // the next save.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw error;
    }

    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        throw new Error(
            `${file} is not valid JSON and was NOT overwritten. ` +
                `Move it aside to start fresh; agent identities live in it. (${String(error)})`,
        );
    }
}

/**
 * Atomic replace, safe under CONCURRENT callers. The Windows VM run of 2026-10-11 passed every test
 * and still exited 1: two AttentionStore flushes in flight shared ONE temp name, and Windows refused
 * the second rename with EPERM (a rename onto a file another handle still holds). So:
 * - writes to the same file are SERIALISED (a per-file promise chain) — the last write wins, whole;
 * - each write has its own temp name, so two can never trample one another's bytes;
 * - a rename refused with EPERM/EBUSY/EACCES (Windows: an indexer or scanner holding the target for a
 *   moment) is retried a few times before it is reported.
 */
const inFlight = new Map<string, Promise<void>>();
let tmpCounter = 0;

/**
 * The one way a fire-and-forget flush is written. A synchronous store method (`add`)
 * cannot await its write; `void this.#flush()` made a failed write an UNHANDLED REJECTION — on CI a
 * test directory removed mid-rename turned 1529 green tests into an exit 1, and in the app the same
 * shape is a lost write that said nothing. Here the failure is reported with the store's name.
 */
export function reportFlush(flush: Promise<void>, what: string): void {
    flush.catch((error: unknown) => {
        console.error(`[genie] ${what} could not be written: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * A file that holds a secret in the clear (host-split plan §13: services.json…): the owner's alone.
 * POSIX modes; on Windows the profile's ACL is the guard, and a mode does nothing.
 */
export const PRIVATE_FILE = { mode: 0o600 } as const;

/**
 * A private file an older Genie left open is tightened when its store opens: it may not be rewritten for a long time. No
 * file yet is fine; a failure is said, never fatal (a store that cannot chmod still works, and no worse than before).
 */
export async function makePrivate(file: string): Promise<void> {
    if (process.platform === 'win32') {
        // A file that is not there yet is fine, as below. A store that cannot tighten an old file still opens; the ACL path has said why.
        if (!(await lstat(file).then(() => true, () => false))) return;
        await restrictPrivateFile(file).catch((error: unknown) => { console.error(`[genie] could not make ${file} private: ${error instanceof Error ? error.message : String(error)}`); });
        return;
    }
    await chmod(file, PRIVATE_FILE.mode).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') console.error(`[genie] could not make ${file} private: ${error.message}`);
    });
}

/**
 * A small secret that is not JSON (host.token, mcp-endpoint.json's text), whole and private before its name appears. On POSIX the mode at create does that; on Windows the temp file is restricted
 * before the rename, so nobody can read it open under its real name.
 */
export async function writeTextPrivate(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    try {
        await writeFile(tmp, text, { encoding: 'utf8', mode: PRIVATE_FILE.mode });
        await restrictPrivateFile(tmp);
        await renameOver(tmp, file);
    } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function writeJsonAtomic(file: string, value: unknown, options?: { readonly mode?: number }): Promise<void> {
    const previous = inFlight.get(file) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(() => writeJsonAtomicNow(file, value, options?.mode));
    inFlight.set(file, mine);
    const settle = (): void => { if (inFlight.get(file) === mine) inFlight.delete(file); };
    void mine.then(settle, settle);
    return mine;
}

/**
 * DURABLE, not only atomic (hosting fixes 3.1): the temp file's bytes are synced before the rename names them — after a
 * power cut the rename could be on disk and the bytes not, and the record came back EMPTY — and on POSIX the directory
 * is synced after, so the rename itself is kept.
 */
async function writeJsonAtomicNow(file: string, value: unknown, mode?: number): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    // The temp file gets the mode: the rename names it, so the secret is never on disk more open than this.
    const handle = await open(tmp, 'w', mode);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    // On Windows the mode above means nothing. The same ACL as a credential's, on the temp file, so the name never points at an open file. A refusal fails the write, and the old file stays.
    if (mode === PRIVATE_FILE.mode) {
        try {
            await restrictPrivateFile(tmp);
        } catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined);
            throw error;
        }
    }
    await renameOver(tmp, file);
    // After the rename, never inside its retries: a failed flush is not a failed rename.
    await syncDirectory(dirname(file));
}

/** Flush a directory's entries (a rename into it). Windows cannot open a directory to flush it, so there it is skipped. */
async function syncDirectory(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(dir, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Narrow an unknown record from disk.
 *
 * A record missing a field is **dropped with its reason named**, not repaired with defaults. A
 * repaired record is worse than a dropped one: an agent whose `threadId` was defaulted to
 * `null` silently starts a brand new conversation, and the user sees an agent that forgot
 * everything rather than one that is missing.
 */
function parseRecord(value: unknown, onDrop: (why: string) => void): AgentRecord | null {
    if (typeof value !== 'object' || value === null) {
        onDrop('not an object');
        return null;
    }

    const raw = value as Record<string, unknown>;
    const missing = AGENT_RECORD_FIELDS.filter((f) => !(f in raw));
    if (missing.length > 0) {
        onDrop(`missing ${missing.join(', ')}`);
        return null;
    }

    const id = typeof raw.id === 'string' ? asAgentId(raw.id) : null;
    if (id === null) {
        onDrop(`id ${JSON.stringify(raw.id)} is not an agent id`);
        return null;
    }

    try {
        return withoutAgentAccount({ ...(raw as unknown as AgentRecord), id });
    } catch {
        onDrop('invalid provider or thread slot namespace');
        return null;
    }
}

const accountUpgrades = new Map<string, Promise<void>>();

/** The host's first read/write durably rewrites older rows to the current shape (no per-agent account, Tynn #751) before any session can use them. Preserve unparseable rows. */
function migrateAgentAccounts(directory: string): Promise<void> {
    const pending = accountUpgrades.get(directory);
    if (pending) return pending;
    const ready = (async () => {
        const file = join(directory, 'agents.json');
        const rows = await readJson<unknown[]>(file, []);
        let changed = false;
        const migrated = rows.map(raw => {
            const parsed = parseRecord(raw, () => {});
            if (!parsed) return raw;
            if (JSON.stringify(parsed) !== JSON.stringify(raw)) changed = true;
            return parsed;
        });
        if (changed) await writeJsonAtomic(file, migrated);
    })().finally(() => { accountUpgrades.delete(directory); });
    accountUpgrades.set(directory, ready);
    return ready;
}

const inboxAccessUpgrades = new Map<string, Promise<void>>();

/** Before any reader or writer can discard the old setting, preserve its restrictions on the agents themselves. */
export function migrateAgentInboxAccess(directory: string): Promise<void> {
    const pending = inboxAccessUpgrades.get(directory);
    if (pending) return pending;
    const ready = upgradeAgentInboxAccess(directory).finally(() => { inboxAccessUpgrades.delete(directory); });
    inboxAccessUpgrades.set(directory, ready);
    return ready;
}

async function upgradeAgentInboxAccess(directory: string): Promise<void> {
    const marker = join(directory, 'agent-inbox-access-migrated.json');
    const done = await readJson<{ version?: unknown } | null>(marker, null);
    if (done?.version === 1) return;

    const file = join(directory, 'agents.json');
    const records = await readJson<unknown[]>(file, []);
    const settings = await readJson<Record<string, unknown>>(join(directory, 'settings.json'), {});
    let changed = false;
    const upgraded = records.map((raw) => {
        // Preserve unparseable rows on disk; the normal reader still names their faults.
        const agent = parseRecord(raw, () => {});
        if (!agent) return raw;
        const overrides = settings?.__workspaces as Record<string, Record<string, unknown> | undefined> | undefined;
        const override = overrides?.[agent.workspaceId]?.inbox_access;
        const old = typeof override === 'string' || typeof override === 'boolean' ? override : settings?.inbox_access;
        const workspaceScope = old === 'none' || old === 'all' ? old : 'self';
        const knownScope = ['none', 'self', 'specific', 'all'].includes(agent.accessScope);
        const accessScope: AgentRecord['accessScope'] = isOsAgent(agent) ? 'all'
            : !knownScope || agent.accessScope === 'none' || workspaceScope === 'none' ? 'none'
            : workspaceScope === 'self' ? 'self' : agent.accessScope;
        if (accessScope === agent.accessScope) return raw;
        changed = true;
        return { ...agent, accessScope };
    });
    // Save restrictions first. A crash before the marker safely repeats the intersection;
    // a failed write prevents boot from exposing an unconverted roster.
    if (changed) await writeJsonAtomic(file, upgraded);
    await writeJsonAtomic(marker, { version: 1 });
}

export class Store {
    readonly #dir: string;
    #inboxAccessReady: Promise<void> | undefined;
    #accountsReady: Promise<void> | undefined;
    /** Records that failed to parse, kept so a boot fault is reportable rather than silent. */
    readonly dropped: string[] = [];

    constructor(userData: string) {
        this.#dir = runtimeDir(userData);
    }

    get workspacesFile(): string {
        return join(this.#dir, 'workspaces.json');
    }

    get agentsFile(): string {
        return join(this.#dir, 'agents.json');
    }

    /** Which agents were RUNNING when Genie last closed (§7.6) — written at quit; each leaves it once restored (Tynn #754). */
    get runningAtQuitFile(): string {
        return join(this.#dir, 'running-at-quit.json');
    }

    async readRunningAtQuit(): Promise<readonly string[]> {
        const raw = await readJson<unknown[]>(this.runningAtQuitFile, []);
        return raw.filter((id): id is string => typeof id === 'string');
    }

    /**
     * A SHUTDOWN'S RECORD of who comes back. Writing it ENDS any restore in flight here (Tynn #754): a start that lands
     * after this cannot take its agent off the record, because the sessions are about to end with the shutdown.
     */
    writeRunningAtQuit(ids: readonly string[]): Promise<void> {
        return this.#atQuit(async () => { this.#restoring = false; await writeJsonAtomic(this.runningAtQuitFile, ids); });
    }

    /** Which agents were MID-TURN when Genie last shut down — their turns were cancelled; they are resumed at launch. */
    get interruptedAtQuitFile(): string {
        return join(this.#dir, 'interrupted-at-quit.json');
    }

    async readInterruptedAtQuit(): Promise<readonly string[]> {
        const raw = await readJson<unknown[]>(this.interruptedAtQuitFile, []);
        return raw.filter((id): id is string => typeof id === 'string');
    }

    writeInterruptedAtQuit(ids: readonly string[]): Promise<void> {
        return this.#atQuit(async () => { this.#restoring = false; await writeJsonAtomic(this.interruptedAtQuitFile, ids); });
    }

    /**
     * THE RESTORE AFTER A RELAUNCH (Tynn #754): both lists are READ, not cleared. Each agent leaves them only once its
     * start went through (`restoreStarted`), so a shutdown inside the restore still finds every agent that had not started
     * yet. They used to be taken (read and emptied) here, before any start: the owner's beta.63 → beta.64 upgrade drained
     * again 60 s into the 3-second-spaced restore, and 25 of 31 agents were lost.
     */
    beginRestore(): Promise<{ running: readonly string[]; interrupted: readonly string[] }> {
        return this.#atQuit(async () => {
            const [running, interrupted] = await Promise.all([this.readRunningAtQuit(), this.readInterruptedAtQuit()]);
            this.#restoring = true;
            return { running, interrupted };
        });
    }

    /**
     * The agent's restore start went through: it leaves both lists. Once a shutdown has written its record since the
     * restore began, nothing is taken off it (that record is what the next launch restores). Answers whether it was.
     */
    restoreStarted(id: string): Promise<boolean> {
        return this.#atQuit(async () => {
            if (!this.#restoring) return false;
            const [running, interrupted] = await Promise.all([this.readRunningAtQuit(), this.readInterruptedAtQuit()]);
            if (running.includes(id)) await writeJsonAtomic(this.runningAtQuitFile, running.filter((x) => x !== id));
            if (interrupted.includes(id)) await writeJsonAtomic(this.interruptedAtQuitFile, interrupted.filter((x) => x !== id));
            return true;
        });
    }

    /** A restore is in flight here: begun, and no shutdown record written since. */
    #restoring = false;
    /** The two at-quit files' changes, one at a time: a restore's read-modify-write never interleaves with a record. */
    #atQuitChain: Promise<unknown> = Promise.resolve();
    #atQuit<T>(fn: () => Promise<T>): Promise<T> {
        const mine = this.#atQuitChain.catch(() => undefined).then(fn);
        this.#atQuitChain = mine;
        return mine;
    }

    async readWorkspaces(): Promise<readonly WorkspaceRecord[]> {
        const raw = await readJson<unknown[]>(this.workspacesFile, []);
        return raw.filter(
            (w): w is WorkspaceRecord =>
                typeof w === 'object' && w !== null &&
                typeof (w as WorkspaceRecord).id === 'string' &&
                typeof (w as WorkspaceRecord).path === 'string',
        );
    }

    /** The whole list, for a first seed (genie-host's own boot, tests). Every registry write is `changeWorkspaces`. */
    async writeWorkspaces(workspaces: readonly WorkspaceRecord[]): Promise<void> {
        await underRecordLock(this.workspacesFile, () => writeJsonAtomic(this.workspacesFile, workspaces));
    }

    /**
     * ONE RECORD AT A TIME (Tynn #1007): the change is applied to the file as it is NOW, under its lock: records added
     * (an id already there is kept as it is), fields set and removed on the records named (a record no longer there is
     * not brought back), records removed (and the governors' lists left by them). What the caller did not name is never
     * written from the caller's copy, so a stale copy cannot clobber anything. Answers the list as it is after.
     */
    changeWorkspaces(change: RecordChange<WorkspaceRecord>): Promise<readonly WorkspaceRecord[]> {
        return underRecordLock(this.workspacesFile, async () => {
            const rows = await readJson<unknown[]>(this.workspacesFile, []);
            const next = applyRecordChange(rows, change);
            const gone = new Set(change.remove ?? []);
            const after = gone.size === 0 ? next : next.map((row) => {
                const governs = (row as { governs?: unknown }).governs;
                if (!Array.isArray(governs) || !governs.some((id) => gone.has(id as string))) return row;
                return { ...(row as object), governs: governs.filter((id) => !gone.has(id as string)) };
            });
            if (JSON.stringify(after) !== JSON.stringify(rows)) await writeJsonAtomic(this.workspacesFile, after);
            return this.readWorkspaces();
        });
    }

    async readAgents(): Promise<readonly AgentRecord[]> {
        await (this.#accountsReady ??= migrateAgentAccounts(this.#dir));
        await (this.#inboxAccessReady ??= migrateAgentInboxAccess(this.#dir));
        const raw = await readJson<unknown[]>(this.agentsFile, []);
        this.dropped.length = 0;

        return raw.flatMap((value, i) => {
            const record = parseRecord(value, (why) => this.dropped.push(`agents.json[${i}]: ${why}`));
            return record ? [record] : [];
        });
    }

    /** The whole list, for a first seed (genie-host's own boot, tests). Every registry write is `changeAgents`. */
    async writeAgents(records: readonly AgentRecord[]): Promise<void> {
        await (this.#accountsReady ??= migrateAgentAccounts(this.#dir));
        await (this.#inboxAccessReady ??= migrateAgentInboxAccess(this.#dir));
        await underRecordLock(this.agentsFile, () => writeJsonAtomic(this.agentsFile, records));
    }

    /**
     * ONE RECORD AT A TIME (Tynn #1007), as `changeWorkspaces`: read-modify-write of the records named, under the file's
     * lock. A removed agent also leaves every chosen-agents list it was on (Tynn #526). A row that does not parse is kept
     * as it is. Answers the agents as they are after.
     */
    async changeAgents(change: RecordChange<AgentRecord>): Promise<readonly AgentRecord[]> {
        await (this.#accountsReady ??= migrateAgentAccounts(this.#dir));
        await (this.#inboxAccessReady ??= migrateAgentInboxAccess(this.#dir));
        return underRecordLock(this.agentsFile, async () => {
            const rows = await readJson<unknown[]>(this.agentsFile, []);
            const next = applyRecordChange(rows, change);
            const gone = new Set(change.remove ?? []);
            const after = gone.size === 0 ? next : next.map((row) => {
                const chosen = (row as { accessAgents?: unknown }).accessAgents;
                if (!Array.isArray(chosen) || !chosen.some((id) => gone.has(id as string))) return row;
                return { ...(row as object), accessAgents: chosen.filter((id) => !gone.has(id as string)) };
            });
            if (JSON.stringify(after) !== JSON.stringify(rows)) await writeJsonAtomic(this.agentsFile, after);
            return this.readAgents();
        });
    }
}

/** One record's change: the fields set, and the fields removed. Never its id. */
export interface RecordPatch {
    readonly id: string;
    readonly set?: Readonly<Record<string, unknown>>;
    readonly unset?: readonly string[];
}

/** A change to one of the registry's lists, by record (Tynn #1007): never the whole list. */
export interface RecordChange<T> {
    readonly add?: readonly T[];
    readonly patch?: readonly RecordPatch[];
    readonly remove?: readonly string[];
}

/** Field names no patch may name: the record's identity, and what would reach an object's prototype. */
export const UNPATCHABLE_FIELDS: readonly string[] = ['id', '__proto__', 'constructor', 'prototype'];

const idOf = (row: unknown): string | null => (typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null);

function applyRecordChange(rows: readonly unknown[], change: RecordChange<{ readonly id: string }>): unknown[] {
    const gone = new Set(change.remove ?? []);
    let next: unknown[] = rows.filter((row) => { const id = idOf(row); return id === null || !gone.has(id); });
    for (const p of change.patch ?? []) {
        next = next.map((row) => {
            if (idOf(row) !== p.id) return row;
            const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
            for (const key of p.unset ?? []) if (!UNPATCHABLE_FIELDS.includes(key)) delete out[key];
            for (const [key, value] of Object.entries(p.set ?? {})) {
                if (UNPATCHABLE_FIELDS.includes(key)) continue;
                if (value === undefined) delete out[key];
                else Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
            }
            return out;
        });
    }
    for (const record of change.add ?? []) if (!gone.has(record.id) && !next.some((row) => idOf(row) === record.id)) next.push(record);
    return next;
}

/**
 * Each registry file's read-modify-writes, one at a time, across every Store object over it in this process: the lock a
 * per-record change holds from its read to its rename.
 */
const recordLocks = new Map<string, Promise<unknown>>();
function underRecordLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const previous = recordLocks.get(file) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(fn);
    recordLocks.set(file, mine);
    const settle = (): void => { if (recordLocks.get(file) === mine) recordLocks.delete(file); };
    void mine.then(settle, settle);
    return mine;
}
