/**
 * Safe points before an upgrade or quit (Tynn #616). No handoff file is required: the existing
 * shutdown record restores each session once. An idle agent is safe immediately; a working one
 * gets a notice and may finish its turn or acknowledge early. The deadline is fleet-wide.
 */
export type ShutdownReason = 'upgrade' | 'quit';
export interface ShutdownAgent { readonly id: string; readonly name: string; readonly running: boolean; readonly inTurn: boolean; }
export interface AgentDrainProgress { readonly waiting: readonly { id: string; name: string }[]; readonly deadline: number; }
export interface AgentDrainOutcome { readonly interrupted: readonly { id: string; name: string }[]; readonly forced: boolean; readonly timedOut: boolean; }
export interface AgentDrainDeps {
    readonly agents: () => readonly ShutdownAgent[];
    readonly notify: (id: string, text: string) => void;
    readonly hold?: () => void;
    readonly release?: () => void;
    readonly now?: () => number;
}
export const AGENT_DRAIN_WAIT_MS = 120_000;
export class AgentShutdownDrain {
    readonly #deps: AgentDrainDeps;
    #result: Promise<AgentDrainOutcome> | null = null;
    #finished = false;
    #forceRequested = false;
    #held = false;
    #active: {
        waiting: Map<string, { id: string; name: string }>;
        deadline: number;
        progress: (state: AgentDrainProgress) => void;
        resolve: (outcome: AgentDrainOutcome) => void;
        timer: ReturnType<typeof setTimeout> | null;
        bound: ReturnType<typeof setTimeout> | null;
    } | null = null;

    constructor(deps: AgentDrainDeps) { this.#deps = deps; }

    /** Recovery only: keep work held at a natural safe point until shutdown commits or fails. */
    release(): void {
        if (this.#active) this.#finish(false, false);
        this.#result = null;
        this.#forceRequested = false;
        this.#finished = false;
        if (this.#held) {
            this.#held = false;
            this.#deps.release?.();
        }
    }

    begin(reason: ShutdownReason, progress: (state: AgentDrainProgress) => void): Promise<AgentDrainOutcome> {
        if (this.#result) return this.#result;
        this.#finished = false;
        let working: readonly ShutdownAgent[] = [];
        try { working = this.#deps.agents().filter((a) => a.running && a.inTurn); } catch { /* unreadable is not a reason to hang shutdown */ }
        const deadline = this.#now() + AGENT_DRAIN_WAIT_MS;
        const result = new Promise<AgentDrainOutcome>((resolve) => {
            this.#active = { waiting: new Map(working.map(({ id, name }) => [id, { id, name }])), deadline, progress, resolve, timer: null, bound: null };
        });
        this.#result = result;
        // The bound is an elapsed timer too: a wall-clock correction cannot lengthen the wait.
        this.#active!.bound = setTimeout(() => this.#finish(false, true), AGENT_DRAIN_WAIT_MS);
        // A notice never interrupts a tool or cancels a turn. Providers that cannot steer may queue
        // it; a natural turn end is sufficient. Hold subsequent work after offering these notices.
        for (const agent of working) {
            try {
                this.#deps.notify(agent.id, `Genie is about to ${reason === 'upgrade' ? 'upgrade' : 'quit'}. Finish your current turn at a safe point; do not start new work. If you are ready sooner, call thumbsUp with reason "shutdown". Genie waits up to 120 seconds, then stops remaining turns and restores your session after restart.`);
            } catch { /* an unreachable agent still has the same bound and remains visible */ }
        }
        this.#held = true;
        try { this.#deps.hold?.(); } catch { this.#finish(false, false); return result; }
        if (this.#forceRequested) { this.#finish(true, false); return result; }
        this.#tick();
        return result;
    }

    acknowledge(id: string): boolean {
        const active = this.#active;
        if (!active?.waiting.delete(id)) return false;
        this.#tick();
        return true;
    }

    force(): boolean {
        if (!this.#active) {
            // The button can arrive while the installer helper is being prepared, before begin.
            // A late duplicate after completion must not arm an unrelated future shutdown.
            if (this.#finished) return false;
            this.#forceRequested = true;
            return true;
        }
        this.#finish(true, false);
        return true;
    }

    #now(): number { return (this.#deps.now ?? Date.now)(); }

    #tick(): void {
        const active = this.#active;
        if (!active) return;
        if (active.timer !== null) { clearTimeout(active.timer); active.timer = null; }
        let live: Map<string, ShutdownAgent>;
        try { live = new Map(this.#deps.agents().map((a) => [a.id, a])); }
        catch { this.#finish(false, false); return; }
        for (const id of active.waiting.keys()) {
            const agent = live.get(id);
            if (!agent?.running || !agent.inTurn) active.waiting.delete(id);
        }
        try { active.progress({ waiting: [...active.waiting.values()], deadline: active.deadline }); }
        catch { /* a failed observer never owns the promise or its deadline */ }
        if (this.#active !== active) return; // An observer may have cancelled/forced this wait.
        if (active.waiting.size === 0) { this.#finish(false, false); return; }
        if (this.#now() >= active.deadline) { this.#finish(false, true); return; }
        active.timer = setTimeout(() => this.#tick(), Math.min(250, active.deadline - this.#now()));
    }

    #finish(forced: boolean, timedOut: boolean): void {
        const active = this.#active;
        if (!active) return;
        this.#active = null;
        this.#result = null;
        this.#finished = true;
        this.#forceRequested = false;
        if (active.timer !== null) clearTimeout(active.timer);
        if (active.bound !== null) clearTimeout(active.bound);
        // Even a thumb is an early acknowledgement, not a claim that inTurn is false. Record the
        // actual turns about to be stopped, so the existing restart path resumes exactly those.
        let interrupted: AgentDrainOutcome['interrupted'] = [];
        try { interrupted = this.#deps.agents().filter((a) => a.running && a.inTurn).map(({ id, name }) => ({ id, name })); }
        catch { /* the roster could not be read; resolve, without inventing interrupted identities */ }
        active.resolve({ interrupted, forced, timedOut });
    }
}
