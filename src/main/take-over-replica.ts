import type { TakeOverProbe } from '../core/observed.js';
import type { AgentId } from '../core/identity.js';
import type { Caller } from './mcp-tools.js';
import type { TakeOverStart, TakeOverView } from './take-over-service.js';

/**
 * TAKE OVER AS A WINDOW READS IT (Tynn #553): genie-host decides, and this holds what it last said, for the Observed row and
 * the Deck, which read synchronously. Nothing is open until genie-host has said so.
 */
export class TakeOverReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #listeners = new Set<() => void>();
    #view: TakeOverView = { live: {}, callers: {} };

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    probe(agentId: string): TakeOverProbe | null { return this.#view.live[agentId] ?? null; }
    callerFor(id: string): Caller | null { return this.#view.callers[id] ?? null; }
    callers(): Readonly<Record<string, Caller>> { return this.#view.callers; }

    async refresh(): Promise<void> { this.deliver((await this.#call('status', [])) as TakeOverView); }
    async start(agentId: AgentId | string): Promise<TakeOverStart> { return (await this.#call('start', [agentId])) as TakeOverStart; }

    /** A Take Over window here closed: the window is the session, so the terminal goes with it. */
    windowClosed(terminalId: string): void {
        void this.#call('ended', [terminalId]).catch((error: unknown) => console.warn(`[take over] ${error instanceof Error ? error.message : String(error)}`));
    }

    /** Listeners hear when the set of TUIs changes; output only updates what the next read sees. */
    deliver(view: TakeOverView): void {
        const key = (v: TakeOverView) => Object.entries(v.live).map(([id, p]) => `${id}=${p.terminalId}`).sort().join();
        const changed = key(view) !== key(this.#view);
        this.#view = view;
        if (changed) for (const l of [...this.#listeners]) l();
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
