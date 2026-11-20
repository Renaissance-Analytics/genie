import { assignWorkspaceColors, colorWrite, manifestColor } from '../core/workspace-color.js';
import { nestGoverned } from '../core/rail-view.js';

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
    readonly mayReadFolder?: (path: string) => boolean;
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
    readonly #mayReadFolder: (path: string) => boolean;
    readonly #fs: WorkspaceColorFs;
    readonly #onChanged: () => void;
    readonly #log: (line: string) => void;
    /** What each workspace path shows: its project.json's colour, else the one assigned in memory. */
    readonly #colors = new Map<string, string>();
    /** One pass at a time; a call during one runs once more after it, with the latest list. */
    #running: Promise<void> | null = null;
    #again: readonly { id: string; path: string }[] | null = null;

    constructor(options: WorkspaceColorsOptions) {
        this.#mayReadFolder = options.mayReadFolder ?? (() => true);
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
        workspaces = workspaces.filter((w) => this.#mayReadFolder(w.path));
        const texts = await Promise.all(workspaces.map((w) => this.#fs.readText(manifestPath(w.path)).catch(() => null)));
        const own = texts.map((t) => manifestColor(parsed(t)));
        const assigned = assignWorkspaceColors(workspaces.map((w, i) => ({ id: w.id, color: own[i] ?? null })));
        let changed = false;
        for (let i = 0; i < workspaces.length; i++) {
            const w = workspaces[i]!;
            if (!this.#mayReadFolder(w.path)) continue;
            let color = assigned[w.id]!;
            if (own[i] === null) {
                const write = colorWrite(texts[i] ?? null, color);
                if (write.ok && write.changed) {
                    try {
                        if (write.backup) await this.#fs.writeTextAtomic(inFolder(w.path, write.backup.name), write.backup.text);
                        if (!this.#mayReadFolder(w.path)) continue;
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
        if (!this.#mayReadFolder(path)) return { ok: false, reason: 'workspace is hibernated; redock it first' };
        const text = await this.#fs.readText(manifestPath(path)).catch(() => null);
        if (!this.#mayReadFolder(path)) return { ok: false, reason: 'workspace is hibernated; redock it first' };
        const write = colorWrite(text, color);
        if (!write.ok) return write;
        if (write.changed) {
            if (write.backup) await this.#fs.writeTextAtomic(inFolder(path, write.backup.name), write.backup.text);
            if (!this.#mayReadFolder(path)) return { ok: false, reason: 'workspace is hibernated; redock it first' };
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

/** What a colour pass follows: a registry's snapshots (main's Registry, genie-host's phoneRegistry). */
export interface ColoredRegistry<W extends ColoredWorkspace = ColoredWorkspace> {
    subscribe(listener: (snapshot: { readonly workspaces?: readonly W[] | null | undefined }) => void): unknown;
    snapshot(): { readonly workspaces?: readonly W[] | null | undefined };
}
export type ColoredWorkspace = { readonly id: string; readonly path: string; readonly color?: string | null | undefined; readonly governedBy?: string | null | undefined };

/**
 * FOLLOW A REGISTRY WITH COLOUR PASSES (Tynn #956): on a snapshot with a workspace still uncoloured (or at most every 5 s),
 * one pass in the rail's order (governed workspaces under their governor) so neighbours differ, then `after` with the
 * workspaces it saw. main and genie-host both follow theirs with this, so they assign the same colours: since Tynn #898
 * step 2d-4b this machine's Dashboard is genie-host's, and its WorkspaceColors had never run a pass.
 */
export function followWorkspaceColors<W extends ColoredWorkspace>(registry: ColoredRegistry<W>, colors: WorkspaceColors, options: { readonly after?: (current: readonly W[]) => unknown; readonly log?: (line: string) => void } = {}): void {
    let passAt = 0;
    let queued = false;
    registry.subscribe((snapshot) => {
        const ws = snapshot.workspaces;
        if (!ws || queued) return;
        if (ws.every((w) => w.color) && Date.now() - passAt < 5_000) return;
        queued = true;
        setTimeout(() => {
            queued = false;
            passAt = Date.now();
            const current = registry.snapshot().workspaces ?? [];
            const order = nestGoverned(current, (id) => current.find((w) => w.id === id)?.governedBy ?? null);
            void colors.ensure(order.map((w) => ({ id: w.id, path: w.path })))
                .catch((error: unknown) => options.log?.(`workspace colours: ${error instanceof Error ? error.message : String(error)}`))
                .then(() => options.after?.(current));
        }, 0);
    });
}

/**
 * Reads project.json, never writes it (genie-host, Tynn #956): main is the one writer of a workspace's colour, ordered
 * before its agent-config move so the two never write one file at once. A colour not yet written is shown from memory.
 */
export function readOnlyColorFs(fs: WorkspaceColorFs): WorkspaceColorFs {
    return {
        readText: (path) => fs.readText(path),
        writeTextAtomic: () => Promise.reject(new Error('read-only: the window writes workspace colours')),
    };
}
