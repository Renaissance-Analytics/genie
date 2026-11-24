import { Coalescer, realSchedule } from '../core/coalesce.js';
import type { AgentRecord } from '../core/identity.js';
import type { TakeOverProbe } from '../core/observed.js';
import type { Caller } from './mcp-tools.js';
import type { TakeOverHost } from './take-over-host.js';

/**
 * TAKE OVER, OWNED BY GENIE-HOST (Tynn #553, host split P5d.5c). Who has a TUI open is decided in one place, so a Pilot's click
 * works with every window closed, a window opened later sees that TUI, and nobody starts a second one on the same agent.
 * This host never opens a window: whoever clicked opens its own, on the terminal it is answered with.
 */

/** How often a window hears about a TUI that keeps printing. Starting and ending are told at once. */
export const TAKE_OVER_PUSH_MS = 1_000;

export type TakeOverStart = { ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string };

export interface TakeOverView {
    readonly live: Readonly<Record<string, TakeOverProbe>>;
    readonly callers: Readonly<Record<string, Caller>>;
}

export interface TakeOverServicePorts {
    readonly host: TakeOverHost;
    find(id: string): AgentRecord | null;
    workspacePath(record: AgentRecord): string | null;
    /** The provider's own CLI, resolved the way a session resolves it. */
    tuiFor(record: AgentRecord): string;
    /**
     * THE WORKSPACE'S VERDICT AS IT IS NOW (Tynn #364), the one its agents read (genie-host's `hostUntrustedNow`): read at each
     * click, never kept. `true` = not trusted, or not read yet.
     */
    untrustedNow(record: AgentRecord): boolean;
    onChange(view: TakeOverView): void;
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    readonly now?: () => number;
}

export class TakeOverService {
    readonly #ports: TakeOverServicePorts;
    readonly #push: Coalescer<'view'>;

    constructor(ports: TakeOverServicePorts) {
        this.#ports = ports;
        this.#push = new Coalescer<'view'>({ intervalMs: TAKE_OVER_PUSH_MS, flush: () => ports.onChange(this.view()), schedule: ports.schedule ?? realSchedule, now: ports.now ?? Date.now });
        ports.host.onChange(() => this.#push.request('view'));
    }

    start(agentId: unknown): TakeOverStart {
        if (typeof agentId !== 'string') return { ok: false, reason: 'No agent named.' };
        const record = this.#ports.find(agentId);
        if (!record) return { ok: false, reason: `No agent is registered as ${agentId}.` };
        const path = this.#ports.workspacePath(record);
        if (path === null) return { ok: false, reason: `${record.name}'s workspace is not registered.` };
        // A TUI already open is found, not started: nothing new runs. A new one is the provider's own CLI in the folder, which
        // loads the folder's settings, hooks and MCP servers with nothing of Genie's in the way: only in a trusted workspace.
        // No prompt of its own: the person says yes once, on the workspace's Trust step (Tynn #618).
        if (this.#ports.host.probe(record.id) === null && this.#ports.untrustedNow(record)) {
            return { ok: false, reason: `${record.name}'s workspace is not trusted, so Genie does not open its provider's own CLI there: the folder's settings, hooks and MCP servers would run. Trust this workspace on its page, then Take Over.` };
        }
        return this.#ports.host.start(record, path, this.#ports.tuiFor(record), { window: false });
    }

    ended(terminalId: string): void {
        this.#ports.host.windowClosed(terminalId);
    }

    view(): TakeOverView {
        return { live: this.#ports.host.live(), callers: this.#ports.host.callers() };
    }

    /** A window's call over the engine link. */
    call(method: string, args: readonly unknown[]): unknown {
        switch (method) {
            case 'status': return this.view();
            case 'start': return this.start(args[0]);
            case 'ended': this.ended(typeof args[0] === 'string' ? args[0] : ''); return null;
            default: throw new Error(`take over has no ${method}`);
        }
    }
}
