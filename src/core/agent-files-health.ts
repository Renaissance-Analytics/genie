/**
 * WHAT THE SYNC DID TO EACH WORKSPACE'S AGENT FILES, kept so Settings can say it (the owner: "workspace agents cannot be
 * left stranded"). A run is a list of steps (gitignore, protocol, routers, skills); each step reports every path it
 * writes or removes, and a step that throws is recorded and does not stop the steps after it. Config-sync results
 * (the four harness configs) are kept beside the run: their failures show until a good run clears them.
 */
export interface AgentFilesReport {
    readonly workspacePath: string;
    readonly at: number;
    /** Workspace-relative paths the last run wrote or removed. */
    readonly changed: readonly string[];
    readonly failed: ReadonlyArray<{ step: string; error: string }>;
}

export interface AgentFilesStep {
    readonly step: string;
    run(touched: (path: string) => void): Promise<void>;
}

export class AgentFilesHealth {
    readonly #runs = new Map<string, { at: number; changed: string[]; failed: Array<{ step: string; error: string }> }>();
    readonly #config = new Map<string, Array<{ step: string; error: string }>>();

    async run(workspacePath: string, steps: readonly AgentFilesStep[], now = Date.now()): Promise<AgentFilesReport> {
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
        this.#runs.set(workspacePath, { at: now, changed, failed });
        return this.#report(workspacePath)!;
    }

    config(workspacePath: string, results: ReadonlyArray<{ label: string; ok: boolean; error?: string }>): void {
        this.#config.set(workspacePath, results.filter((r) => !r.ok).map((r) => ({ step: r.label, error: r.error ?? 'failed' })));
    }

    list(): AgentFilesReport[] {
        return [...new Set([...this.#runs.keys(), ...this.#config.keys()])].map((w) => this.#report(w)!);
    }

    #report(workspacePath: string): AgentFilesReport | null {
        const run = this.#runs.get(workspacePath);
        const config = this.#config.get(workspacePath) ?? [];
        if (!run && config.length === 0 && !this.#config.has(workspacePath)) return null;
        return { workspacePath, at: run?.at ?? 0, changed: run?.changed ?? [], failed: [...(run?.failed ?? []), ...config] };
    }
}

/** The one line Settings shows for a workspace. */
export function agentFilesLine(r: AgentFilesReport): string {
    if (r.failed.length > 0) return `failed: ${r.failed.map((f) => `${f.step}: ${f.error}`).join('; ')}`;
    if (r.changed.length === 0) return 'current';
    const shown = r.changed.slice(0, 3).join(', ');
    return r.changed.length > 3 ? `upgraded: ${shown} (+${r.changed.length - 3} more)` : `upgraded: ${shown}`;
}
