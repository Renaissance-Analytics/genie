import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
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
