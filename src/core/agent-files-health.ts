/**
 * WHAT THE SYNC DID TO EACH WORKSPACE'S AGENT FILES, kept so Settings can say it (the owner: "workspace agents cannot be
 * left stranded"). A run is a list of steps (gitignore, protocol, routers, skills); each step reports every path it
 * writes or removes, and a step that throws is recorded and does not stop the steps after it. Config-sync results
 * (the four harness configs) are kept beside the run: their failures show until a good run clears them.
 *
 * Each record says WHEN and WHO: Genie's own sync at start (and when a workspace is added) or your Sync now in the
 * workspace's Settings. Without it, Genie start's record read as the result of a click (the owner, 2026-10-13: "I chose
 * one workspace but it updated all workspaces").
 */
export type SyncSource = 'start' | 'you';

export interface AgentFilesReport {
    readonly workspacePath: string;
    /** When the latest of the docs run and the config sync happened. */
    readonly at: number;
    /** Who started that latest one: Genie at start, or you. */
    readonly source: SyncSource;
    /** Workspace-relative paths the last run wrote or removed. */
    readonly changed: readonly string[];
    readonly failed: ReadonlyArray<{ step: string; error: string }>;
}

export interface AgentFilesStep {
    readonly step: string;
    run(touched: (path: string) => void): Promise<void>;
}

export class AgentFilesHealth {
    readonly #runs = new Map<string, { at: number; source: SyncSource; changed: string[]; failed: Array<{ step: string; error: string }> }>();
    readonly #config = new Map<string, { at: number; source: SyncSource; failed: Array<{ step: string; error: string }> }>();

    async run(workspacePath: string, steps: readonly AgentFilesStep[], now = Date.now(), source: SyncSource = 'start'): Promise<AgentFilesReport> {
        const changed: string[] = [];
        const failed: Array<{ step: string; error: string }> = [];
        const prefix = `${workspacePath.replace(/[\\/]+$/, '')}/`;
        const touched = (path: string) => {
            const p = path.replace(/\\/g, '/');
            const rel = p.startsWith(prefix.replace(/\\/g, '/')) ? p.slice(prefix.length) : p;
            if (!changed.includes(rel)) changed.push(rel);
        };
        for (const s of steps) {
            try { await s.run(touched); } catch (error) { failed.push({ step: s.step, error: (error as Error).message }); }
        }
        this.#runs.set(workspacePath, { at: now, source, changed, failed });
        return this.#report(workspacePath)!;
    }

    config(workspacePath: string, results: ReadonlyArray<{ label: string; ok: boolean; error?: string }>, now = Date.now(), source: SyncSource = 'start'): void {
        this.#config.set(workspacePath, { at: now, source, failed: results.filter((r) => !r.ok).map((r) => ({ step: r.label, error: r.error ?? 'failed' })) });
    }

    list(): AgentFilesReport[] {
        return [...new Set([...this.#runs.keys(), ...this.#config.keys()])].map((w) => this.#report(w)!);
    }

    #report(workspacePath: string): AgentFilesReport | null {
        const run = this.#runs.get(workspacePath);
        const config = this.#config.get(workspacePath);
        if (!run && !config) return null;
        // The latest of the two says when, and who.
        const latest = !config || (run && run.at > config.at) ? run! : config;
        return { workspacePath, at: latest.at, source: latest.source, changed: run?.changed ?? [], failed: [...(run?.failed ?? []), ...(config?.failed ?? [])] };
    }
}

/** The one line Settings shows for a workspace. */
export function agentFilesLine(r: AgentFilesReport): string {
    if (r.failed.length > 0) return `failed: ${r.failed.map((f) => `${f.step}: ${f.error}`).join('; ')}`;
    if (r.changed.length === 0) return 'current';
    const shown = r.changed.slice(0, 3).join(', ');
    return r.changed.length > 3 ? `upgraded: ${shown} (+${r.changed.length - 3} more)` : `upgraded: ${shown}`;
}

/** When, and who: `at Genie start · 11:54`, `by you · 12:55` (local time). */
export function agentFilesWhen(r: AgentFilesReport): string {
    const d = new Date(r.at);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return r.source === 'you' ? `by you · ${hhmm}` : `at Genie start · ${hhmm}`;
}
