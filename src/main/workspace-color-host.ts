import { assignWorkspaceColors, colorWrite, manifestColor } from '../core/workspace-color.js';

/**
 * WORKSPACE COLOURS IN MAIN (genie#1300) — the half over `core/workspace-color.ts`.
 *
 * The colour lives in the workspace's project.json (`appearance.color`), and nowhere else: there is no side file, so an
 * agent reads the colour a person sees, and an agent that sets it is what Genie shows after its next pass.
 *
 * - `ensure` reads every workspace's project.json, gives each one without a colour a palette colour (in the rail's
 *   order, so neighbours differ) and WRITES it there. A workspace Genie may not write (no project.json, a newer schema)
 *   still gets a colour on screen, held in memory — never written anywhere else.
 * - `set` is the workspace's Settings: the chosen colour, written the same way.
 * - `colorOf` answers synchronously from what the last pass read, for the registry's snapshot.
 */

export interface WorkspaceColorFs {
    /** The file's text, or `null` when it does not exist. */
    readText(path: string): Promise<string | null>;
    /** Replace the file whole (temp + rename). */
    writeTextAtomic(path: string, text: string): Promise<void>;
}

export interface WorkspaceColorsOptions {
    readonly fs: WorkspaceColorFs;
    /** Something a window shows changed: the registry re-emits its snapshot. */
    readonly onChanged: () => void;
    readonly log?: (line: string) => void;
}

type Result = { ok: true } | { ok: false; reason: string };

/** A file in the workspace folder: `/` works on every platform, and keeps the path the one the caller gave. */
const inFolder = (workspacePath: string, name: string): string => `${workspacePath.replace(/[\\/]+$/, '')}/${name}`;
const manifestPath = (workspacePath: string): string => inFolder(workspacePath, 'project.json');

function parsed(text: string | null): unknown {
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export class WorkspaceColors {
    readonly #fs: WorkspaceColorFs;
    readonly #onChanged: () => void;
    readonly #log: (line: string) => void;
    /** What each workspace path shows: its project.json's colour, else the one assigned in memory. */
    readonly #colors = new Map<string, string>();
    /** One pass at a time; a call during one runs once more after it, with the latest list. */
    #running: Promise<void> | null = null;
    #again: readonly { id: string; path: string }[] | null = null;

    constructor(options: WorkspaceColorsOptions) {
        this.#fs = options.fs;
        this.#onChanged = options.onChanged;
        this.#log = options.log ?? (() => {});
    }

    colorOf(path: string): string | null {
        return this.#colors.get(path) ?? null;
    }

    ensure(workspaces: readonly { id: string; path: string }[]): Promise<void> {
        if (this.#running) {
            this.#again = workspaces;
            return this.#running;
        }
        this.#running = (async () => {
            try {
                let list: readonly { id: string; path: string }[] | null = workspaces;
                while (list) {
                    this.#again = null;
                    await this.#pass(list);
                    list = this.#again;
                }
            } finally {
                this.#running = null;
            }
        })();
        return this.#running;
    }

    async #pass(workspaces: readonly { id: string; path: string }[]): Promise<void> {
        const texts = await Promise.all(workspaces.map((w) => this.#fs.readText(manifestPath(w.path)).catch(() => null)));
        const own = texts.map((t) => manifestColor(parsed(t)));
        const assigned = assignWorkspaceColors(workspaces.map((w, i) => ({ id: w.id, color: own[i] ?? null })));
        let changed = false;
        for (let i = 0; i < workspaces.length; i++) {
            const w = workspaces[i]!;
            let color = assigned[w.id]!;
            if (own[i] === null) {
                const write = colorWrite(texts[i] ?? null, color);
                if (write.ok && write.changed) {
                    try {
                        if (write.backup) await this.#fs.writeTextAtomic(inFolder(w.path, write.backup.name), write.backup.text);
                        await this.#fs.writeTextAtomic(manifestPath(w.path), write.text);
                        this.#log(`[workspace-color] ${w.id}: ${color} written to project.json`);
                    } catch (error) {
                        this.#log(`[workspace-color] ${w.id}: could not write project.json (${error instanceof Error ? error.message : String(error)}); shown, not saved`);
                    }
                }
            } else {
                color = own[i]!;
            }
            if (this.#colors.get(w.path) !== color) {
                this.#colors.set(w.path, color);
                changed = true;
            }
        }
        if (changed) this.#onChanged();
    }

    async set(path: string, color: string): Promise<Result> {
        const text = await this.#fs.readText(manifestPath(path)).catch(() => null);
        const write = colorWrite(text, color);
        if (!write.ok) return write;
        if (write.changed) {
            if (write.backup) await this.#fs.writeTextAtomic(inFolder(path, write.backup.name), write.backup.text);
            await this.#fs.writeTextAtomic(manifestPath(path), write.text);
        }
        const now = manifestColor(parsed(write.text))!;
        if (this.#colors.get(path) !== now) {
            this.#colors.set(path, now);
            this.#onChanged();
        }
        return { ok: true };
    }
}
