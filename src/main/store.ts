import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_RECORD_FIELDS, asAgentId, type AgentRecord } from '../core/identity.js';
import { runtimeDir } from './paths.js';

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
    /** Ops project (§6.1): the workspace ids this one GOVERNS. A Genie-side relation; the envelope schema has no such field. */
    governs?: string[];
    /** Its DEFAULT AGENT (Genie 1's): one of its own agents, the one an action uses when it names none. Absent = none. */
    defaultAgentId?: string;
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
 * The one way a fire-and-forget flush is written. A synchronous store method (`markSeen`, `add`)
 * cannot await its write; `void this.#flush()` made a failed write an UNHANDLED REJECTION — on CI a
 * test directory removed mid-rename turned 1529 green tests into an exit 1, and in the app the same
 * shape is a lost write that said nothing. Here the failure is reported with the store's name.
 */
export function reportFlush(flush: Promise<void>, what: string): void {
    flush.catch((error: unknown) => {
        console.error(`[genie] ${what} could not be written: ${error instanceof Error ? error.message : String(error)}`);
    });
}

export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const previous = inFlight.get(file) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(() => writeJsonAtomicNow(file, value));
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
async function writeJsonAtomicNow(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    const handle = await open(tmp, 'w');
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    for (let attempt = 0; ; attempt += 1) {
        try {
            await rename(tmp, file);
            break;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
                await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
                continue;
            }
            await rm(tmp, { force: true }).catch(() => undefined);
            throw error;
        }
    }
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

    return { ...(raw as unknown as AgentRecord), id };
}

export class Store {
    readonly #dir: string;
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

    /** Which agents were RUNNING when Genie last closed (§7.6) — written at quit, taken once at launch. */
    get runningAtQuitFile(): string {
        return join(this.#dir, 'running-at-quit.json');
    }

    async readRunningAtQuit(): Promise<readonly string[]> {
        const raw = await readJson<unknown[]>(this.runningAtQuitFile, []);
        return raw.filter((id): id is string => typeof id === 'string');
    }

    async writeRunningAtQuit(ids: readonly string[]): Promise<void> {
        await writeJsonAtomic(this.runningAtQuitFile, ids);
    }

    /** Which agents were MID-TURN when Genie last shut down — their turns were cancelled; they are resumed at launch. */
    get interruptedAtQuitFile(): string {
        return join(this.#dir, 'interrupted-at-quit.json');
    }

    async readInterruptedAtQuit(): Promise<readonly string[]> {
        const raw = await readJson<unknown[]>(this.interruptedAtQuitFile, []);
        return raw.filter((id): id is string => typeof id === 'string');
    }

    async writeInterruptedAtQuit(ids: readonly string[]): Promise<void> {
        await writeJsonAtomic(this.interruptedAtQuitFile, ids);
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

    async writeWorkspaces(workspaces: readonly WorkspaceRecord[]): Promise<void> {
        await writeJsonAtomic(this.workspacesFile, workspaces);
    }

    async readAgents(): Promise<readonly AgentRecord[]> {
        const raw = await readJson<unknown[]>(this.agentsFile, []);
        this.dropped.length = 0;

        return raw.flatMap((value, i) => {
            const record = parseRecord(value, (why) => this.dropped.push(`agents.json[${i}]: ${why}`));
            return record ? [record] : [];
        });
    }

    async writeAgents(records: readonly AgentRecord[]): Promise<void> {
        await writeJsonAtomic(this.agentsFile, records);
    }
}
