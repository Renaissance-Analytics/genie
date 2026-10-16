import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OUTPUT_CAP } from '../core/workspace-view.js';

/**
 * TERMINAL SNAPSHOTS PERSISTED ON QUIT (§6.5). The LAST terminal's scrollback per workspace, saved when
 * Genie closes and handed back ONCE on the next launch so the Workspace surface seeds its first terminal
 * above the `— previous session —` divider. Capped from the front (newest kept); empty is not saved; a
 * save replaces the whole set — a workspace with no terminals at quit has nothing to restore.
 */
export class TerminalSnapshots {
    readonly #file: string;
    #byWorkspace: Record<string, string>;
    #pending: Promise<void> = Promise.resolve();

    private constructor(file: string, initial: Record<string, string>) {
        this.#file = file;
        this.#byWorkspace = initial;
    }

    static async open(userData: string): Promise<TerminalSnapshots> {
        const file = join(userData, 'terminal-snapshots.json');
        let initial: Record<string, string> = {};
        try {
            const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                initial = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
            }
        } catch {
            // No file, or an unreadable one: nothing to restore — never a crash at boot.
        }
        return new TerminalSnapshots(file, initial);
    }

    async save(entries: ReadonlyArray<{ workspaceId: string; scrollback: string }>): Promise<void> {
        const next: Record<string, string> = {};
        for (const e of entries) {
            if (e.scrollback.length === 0) continue;
            next[e.workspaceId] = e.scrollback.length > OUTPUT_CAP ? e.scrollback.slice(e.scrollback.length - OUTPUT_CAP) : e.scrollback;
        }
        this.#byWorkspace = next;
        await this.#write();
    }

    /** The previous session's scrollback for this workspace, ONCE; `null` afterwards and for unknown workspaces. */
    take(workspaceId: string): string | null {
        const text = this.#byWorkspace[workspaceId];
        if (text === undefined) return null;
        const { [workspaceId]: _taken, ...rest } = this.#byWorkspace;
        this.#byWorkspace = rest;
        this.#pending = this.#pending.then(() => this.#write());
        return text;
    }

    async flushed(): Promise<void> {
        await this.#pending;
    }

    async #write(): Promise<void> {
        await mkdir(dirname(this.#file), { recursive: true });
        const tmp = `${this.#file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(this.#byWorkspace), 'utf8');
        await rename(tmp, this.#file);
    }
}
