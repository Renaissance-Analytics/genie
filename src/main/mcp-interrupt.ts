import { callerFrom } from './mcp-callers.js';
import type { Registration } from './mcp-tools.js';

/**
 * GENIE ENDS ITS OWN TOOL CALLS WHEN THE TURN IS CANCELLED (Tynn #702). The owner's moic agent sat in two long
 * `services exec` calls (`php artisan test`); he interrupted it, Claude Code did not answer the interrupt while it waited on
 * Genie's tool, prism-acp gave up after 30 s and ended the CLI. A call of Genie's own is Genie's to end: on Interrupt (or
 * Stop this turn) every Genie tool call still running for that agent returns at once with the reason, and its handler's
 * signal is aborted, the same signal a client's `notifications/cancelled` aborts, so a command it runs is told to stop.
 */
export const INTERRUPTED_WORDS = {
    interrupt: 'Stopped because you interrupted.',
    stop: 'Stopped because you stopped the turn.',
} as const;

type Intent = keyof typeof INTERRUPTED_WORDS;

/** The Genie tool calls running for each agent: what an interrupt ends. */
export class AgentToolCalls {
    readonly #calls = new Map<string, Set<(intent: Intent) => void>>();

    /** A call starts: how to end it. The answer ends its registration, however the call ends. */
    begin(agentId: string, end: (intent: Intent) => void): () => void {
        const set = this.#calls.get(agentId) ?? new Set();
        set.add(end);
        this.#calls.set(agentId, set);
        return () => {
            set.delete(end);
            if (set.size === 0 && this.#calls.get(agentId) === set) this.#calls.delete(agentId);
        };
    }

    /** End every call running for this agent. How many were ended. */
    end(agentId: string, intent: Intent): number {
        const set = this.#calls.get(agentId);
        if (!set) return 0;
        const ends = [...set];
        for (const end of ends) { try { end(intent); } catch { /* one call that cannot be ended must not keep the others */ } }
        return ends.length;
    }

    running(agentId: string): number {
        return this.#calls.get(agentId)?.size ?? 0;
    }
}

/**
 * Every registration, its calls kept in `calls` by the agent that made them. A call by no agent Genie knows (a terminal, a
 * flow) runs as before. Ended, a call answers at once, whether or not its handler listens to the signal.
 */
export function withInterruptibleCalls(registrations: readonly Registration[], resolve: (session: string) => { readonly agentId: string } | null, calls: AgentToolCalls): Registration[] {
    return registrations.map((r) => ({
        ...r,
        handler: async (args, context) => {
            const caller = callerFrom(args, context.headers ?? {}, resolve);
            if (typeof caller === 'string') return r.handler(args, context);
            const controller = new AbortController();
            const outer = context.signal;
            if (outer) {
                if (outer.aborted) controller.abort(outer.reason);
                else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
            }
            let ended: Intent | null = null;
            let wake: () => void = () => {};
            const stopped = new Promise<null>((done) => { wake = () => done(null); });
            const forget = calls.begin(caller.agentId, (intent) => {
                if (ended !== null) return;
                ended = intent;
                controller.abort(new Error(INTERRUPTED_WORDS[intent]));
                wake();
            });
            try {
                const result = await Promise.race([Promise.resolve(r.handler(args, { ...context, signal: controller.signal })), stopped]);
                if (ended !== null) return { text: INTERRUPTED_WORDS[ended], isError: true };
                return result!;
            } finally {
                forget();
            }
        },
    }));
}
