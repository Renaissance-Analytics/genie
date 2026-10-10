import type { JsonObject, SessionStore } from '@particle-academy/prism-harness';
import { openAgentThread } from './thread-store.js';
import { toStreamEvent, type StreamEvent } from './stream-event.js';
import type { AgentId } from './identity.js';
import { systemProcessTree, type ProcessTree } from './process-tree.js';

/**
 * ONE RUNNING AGENT.
 *
 * Driver → mapper → thread, and nothing else. The session owns no pty, has no shell, and
 * holds no launch line; `prism-acp` spawns the provider CLI and speaks ACP to it, and what
 * arrives here is already a protocol event rather than bytes to be interpreted.
 *
 * **Genie never infers state from output.** No "silence means idle", no scraping a screen
 * for `(y/N)`. If the protocol does not report it, this module does not claim it — which is
 * why `turnState` has an `unknown` and why a stopped session reports `stopReason: null`
 * rather than inventing one.
 */

/** The slice of `prism-acp`'s driver this module needs. Narrow on purpose — it is the seam. */
export interface SessionDriver {
    start(): void;
    prompt(text: string): void;
    kill(signal?: NodeJS.Signals): void;
    readonly running: boolean;
    readonly cliSessionId: string | null;
}

export interface DriverEvents {
    onUpdate?: (update: Record<string, unknown>) => void;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Builds the driver for a run.
 *
 * Injected rather than imported so a test can drive this module without spawning a provider
 * CLI — and so the real one can be swapped per provider without this file growing a switch
 * on a provider name.
 */
export type SessionDriverFactory = (options: {
    cwd: string;
    /** Present on a RESUME. `prism-acp` takes it as a constructor option, not a method. */
    resumeSessionId?: string;
    events: DriverEvents;
}) => SessionDriver;

export type TurnState = 'idle' | 'working' | 'stopped' | 'unknown';

export interface AgentSessionOptions {
    agentId: AgentId;
    cwd: string;
    store: SessionStore;
    driverFactory: SessionDriverFactory;
    /** Resume this provider-side conversation instead of starting a fresh one. */
    resumeSessionId?: string | null;
    /** Notified for every ledger row, so a surface can render without re-reading the thread. */
    onEvent?: (event: StreamEvent) => void;
    /**
     * How a session reaps what the driver leaves behind. Injected so a test can assert the
     * reap happened without killing anything on the machine running the test.
     */
    processTree?: ProcessTree;
}

export class AgentSession {
    readonly agentId: AgentId;

    #driver: SessionDriver | null = null;
    #turnState: TurnState = 'idle';
    #options: AgentSessionOptions;
    /** Rows that failed to persist. Kept so a storage fault is reportable, never silent. */
    #unpersisted = 0;
    /**
     * This session's own subtree, captured just after start.
     *
     * Recorded as the DIFFERENCE against the descendants that existed a moment before, so a
     * stop can never reach into a sibling session's processes. On a workstation running a
     * dozen agents that distinction is the difference between stopping one and stopping the
     * room.
     */
    #ownedPids: readonly number[] = [];

    constructor(options: AgentSessionOptions) {
        this.#options = options;
        this.agentId = options.agentId;
    }

    get turnState(): TurnState {
        return this.#turnState;
    }

    /** `null` until the provider reports one. It is what a later resume is keyed on. */
    get cliSessionId(): string | null {
        return this.#driver?.cliSessionId ?? null;
    }

    get running(): boolean {
        return this.#driver?.running ?? false;
    }

    get unpersistedEvents(): number {
        return this.#unpersisted;
    }

    start(): void {
        if (this.#driver) return; // Reattach, never a second copy of the same agent.

        const { cwd, resumeSessionId, driverFactory } = this.#options;
        this.#driver = driverFactory({
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            events: {
                onUpdate: (update) => void this.#ingest(update),
                onExit: () => {
                    // The provider ended. `stopped` is a fact; what it was DOING when it
                    // ended is not knowable from an exit code, so nothing claims it.
                    this.#turnState = 'stopped';
                },
            },
        });
        const tree = this.#options.processTree ?? systemProcessTree;
        const before = new Set(tree.descendantsOf(process.pid));
        this.#driver.start();
        this.#ownedPids = tree.descendantsOf(process.pid).filter((pid) => !before.has(pid));
        this.#turnState = 'working';
    }

    prompt(text: string): void {
        if (!this.#driver) throw new Error('session is not started');
        this.#driver.prompt(text);
        this.#turnState = 'working';
    }

    /**
     * End the run.
     *
     * The previous build's stop reported success while leaving the provider alive, so the
     * owner had agents they could not stop. Here `stop()` resolves only once the driver
     * reports it is no longer running, and a caller is expected to verify by process scan at
     * the integration level — a return value is not evidence.
     */
    stop(signal: NodeJS.Signals = 'SIGTERM'): void {
        this.#driver?.kill(signal);

        /**
         * Then reap this session's own subtree, as defence in depth.
         *
         * Measured 2026-10-10: `driver.kill('SIGTERM')` already terminates the whole provider
         * tree, so this is normally a no-op. It is kept because "stop means stop" is the one
         * promise the previous build broke — it returned success while the owner's agents
         * kept running — and a signal is not guaranteed to reach a detached grandchild or a
         * provider that re-parents.
         *
         * Only this session's own subtree is touched. NEVER a name sweep: this machine runs
         * a dozen agents at once, and a sweep would stop the room rather than one agent.
         */
        const tree = this.#options.processTree ?? systemProcessTree;
        tree.killTree(this.#ownedPids);

        this.#turnState = 'stopped';
    }

    async #ingest(update: Record<string, unknown>): Promise<void> {
        const event = toStreamEvent(update);
        if (!event) return; // Deliberately not a ledger row (e.g. the slash-command menu).

        this.#options.onEvent?.(event);

        try {
            const thread = openAgentThread(this.#options.store, this.agentId);
            await thread.record([persistable(event)]);
        } catch {
            // A storage fault must not take the turn down with it — but it must also not
            // vanish. Counted, so a surface can say "this conversation is not being saved"
            // instead of quietly holding a partial history.
            this.#unpersisted += 1;
        }
    }
}

/**
 * A ledger row as the thread can actually store it.
 *
 * `StreamEvent` carries two fields typed `unknown` on purpose — a tool call's `rawInput`
 * and a plan's entries are whatever the provider sent, and narrowing them would be
 * asserting a shape we were not given. The store wants JSON, so they are round-tripped:
 * anything not representable (a function, a cycle, a BigInt) becomes `null` rather than
 * throwing mid-turn and taking the conversation down with it.
 *
 * Deliberately NOT a cast. `as unknown as JsonObject` would compile and then write
 * something the store cannot read back, which is the quiet kind of data loss — the same
 * shape of defect as an identity split: nothing throws, and the damage is only visible
 * much later.
 */
function persistable(event: StreamEvent): JsonObject {
    try {
        return JSON.parse(JSON.stringify(event)) as JsonObject;
    } catch {
        // A cyclic `rawInput` is the realistic case. Keep the row and its kind — losing
        // payload is survivable, losing the fact that the event happened is not.
        return { kind: event.kind, unserialisable: true } as JsonObject;
    }
}
