/**
 * THE MCP SHUTTLE'S CORE — what a tool call gets while Genie is being replaced.
 *
 * Phase 1 of genie#346, `.ai/plans/genie-mcp-shuttle-spec.md` §5. This is the state
 * machine and nothing else: no process, no socket, no HTTP, no manifest. The
 * publisher is injected, so the design's hard question can be tested directly.
 *
 * ## Why a shuttle exists at all
 *
 * The MCP server lives inside Electron main, so every upgrade kills it and severs
 * every agent's `genie` and `genie-agentinbox-channel` connection. The shuttle is a
 * long-lived process that owns the listener and FORWARDS each call to whichever
 * Genie is attached. Genie can be replaced underneath it; the agent's connection
 * never drops. This file is the part that decides what happens in the gap.
 *
 * ## The three states (§5.1)
 *
 * | state     | publisher        | a tools/call is…                     |
 * |-----------|------------------|--------------------------------------|
 * | attached  | connected        | forwarded                            |
 * | detached  | gone < grace     | PARKED, delivered on re-attach       |
 * | orphaned  | gone >= grace    | failed, named and honest             |
 *
 * A cold shuttle with no Genie yet is DETACHED, not broken.
 *
 * ## The rule this file exists to enforce: NEVER REPLAY
 *
 * A call already dispatched when the publisher dies is LOST — its implementation
 * died with the process. It is answered `GenieSwapInterrupted` and is NOT sent to
 * the new Genie. `manageProcess create`, `manageSite start` and `provisionWorkspaces`
 * are not idempotent, so a silent replay could start a second container or
 * provision a second workspace. Only the agent knows whether the call was safe to
 * repeat, so only the agent may repeat it.
 *
 * A call that had only been PARKED was never started, so delivering it on
 * re-attach is not a replay — it is the first attempt, late. That distinction —
 * in-flight versus parked — is the whole of §5.2.
 *
 * ## The errors (§5.3)
 *
 * Each names WHICH component is unavailable and what is still true. The failure
 * being designed out is a disconnect that reads as "the tools are broken", which is
 * exactly how genie#346 presented to agents.
 */

/** How long a publisher may be gone before parked calls give up. Injectable. */
export const SWAP_GRACE_MS = 90_000;

/** How many calls may wait for a publisher. The oldest is evicted past this, so a
 *  wedged Genie cannot make the shuttle grow without limit. */
export const PARK_CAP = 64;

/**
 * From the implementation-defined range `-32000..-32019`; MCP reserves
 * `-32020..-32099` for itself.
 */
export const SHUTTLE_ERROR_CODES = {
    GenieSwapInterrupted: -32010,
    GenieDetached: -32011,
    GenieOrphaned: -32012,
} as const;

export type ShuttleState = 'attached' | 'detached' | 'orphaned';

/** A JSON-RPC request as it arrived on the listener. Never inspected or rewritten —
 *  the shuttle is a pipe with a manifest. */
export interface ShuttleRequest {
    id: string | number;
    method: string;
    params?: unknown;
}

export interface ShuttleResponse {
    result?: unknown;
    error?: { code: number; message: string };
}

/** What the core hands the publisher. `correlationId` is the shuttle's own, so a
 *  result can be matched regardless of what id the client chose. */
export interface DispatchFrame {
    correlationId: number;
    generation: number;
    request: ShuttleRequest;
}

export interface Publisher {
    dispatch(frame: DispatchFrame): void;
}

type Respond = (response: ShuttleResponse) => void;

interface Pending {
    request: ShuttleRequest;
    respond: Respond;
}

export interface ShuttleCoreOptions {
    now: () => number;
    graceMs?: number;
    parkCap?: number;
}

export interface ShuttleCore {
    state(): ShuttleState;
    /** A publisher authenticated. Delivers every parked call, in arrival order. */
    attach(publisher: Publisher, generation: number): void;
    /** The publisher went away. In-flight calls are answered as interrupted. */
    detach(): void;
    /** A tools/call arrived on the listener. */
    call(request: ShuttleRequest, respond: Respond): void;
    /** The publisher answered a dispatched frame. */
    result(correlationId: number, response: ShuttleResponse): void;
    /** Advance time-based transitions (detached → orphaned). */
    tick(): void;
}

const error = (code: number, message: string): ShuttleResponse => ({ error: { code, message } });

const swapInterrupted = (): ShuttleResponse =>
    error(
        SHUTTLE_ERROR_CODES.GenieSwapInterrupted,
        'This call was in flight when Genie was replaced by an upgrade. It did not complete. ' +
            'Genie is coming back; re-issue it if it is safe to repeat.',
    );

const detached = (): ShuttleResponse =>
    error(
        SHUTTLE_ERROR_CODES.GenieDetached,
        'Genie is not attached to the MCP shuttle right now (it may be restarting), and too many ' +
            'calls were already waiting for it. Your connection is fine and discovery still works. ' +
            'Retry this call in a few seconds.',
    );

const orphaned = (seconds: number): ShuttleResponse =>
    error(
        SHUTTLE_ERROR_CODES.GenieOrphaned,
        `No Genie has been attached for ${seconds} seconds. Your connection is fine; Genie itself ` +
            'is not running.',
    );

export function createShuttleCore(opts: ShuttleCoreOptions): ShuttleCore {
    const graceMs = opts.graceMs ?? SWAP_GRACE_MS;
    const parkCap = opts.parkCap ?? PARK_CAP;

    let publisher: Publisher | null = null;
    let generation = 0;
    /** When the publisher left — or when the shuttle booted, for a cold start. */
    let detachedAt = opts.now();
    let isOrphaned = false;
    let nextCorrelation = 1;

    /** Dispatched to the CURRENT publisher, awaiting a result. */
    const inFlight = new Map<number, Pending>();
    /** Received while no publisher was attached, awaiting one. Arrival order. */
    const parked: Pending[] = [];

    const dispatch = (p: Pending): void => {
        const correlationId = nextCorrelation++;
        inFlight.set(correlationId, p);
        publisher!.dispatch({ correlationId, generation, request: p.request });
    };

    return {
        state() {
            if (publisher) return 'attached';
            return isOrphaned ? 'orphaned' : 'detached';
        },

        attach(next, gen) {
            publisher = next;
            generation = gen;
            isOrphaned = false;
            // Parked calls were never started, so this is their FIRST attempt.
            // splice(0) empties the queue before dispatching, so a dispatch that
            // synchronously triggers another call cannot reorder the backlog.
            for (const p of parked.splice(0)) dispatch(p);
        },

        detach() {
            publisher = null;
            detachedAt = opts.now();
            // In-flight calls died with the publisher. Answer each as interrupted
            // and FORGET it: a late result for one of these must not produce a
            // second, contradicting answer, and it must never be re-dispatched.
            for (const p of inFlight.values()) p.respond(swapInterrupted());
            inFlight.clear();
        },

        call(request, respond) {
            if (publisher) {
                dispatch({ request, respond });
                return;
            }
            if (isOrphaned) {
                respond(orphaned(Math.floor((opts.now() - detachedAt) / 1000)));
                return;
            }
            parked.push({ request, respond });
            if (parked.length > parkCap) parked.shift()!.respond(detached());
        },

        result(correlationId, response) {
            const p = inFlight.get(correlationId);
            // Unknown id: already answered as interrupted, or never ours. Either
            // way there is nobody left to tell, and telling them twice is worse.
            if (!p) return;
            inFlight.delete(correlationId);
            p.respond(response);
        },

        tick() {
            if (publisher || isOrphaned) return;
            if (opts.now() - detachedAt < graceMs) return;
            isOrphaned = true;
            const seconds = Math.floor((opts.now() - detachedAt) / 1000);
            for (const p of parked.splice(0)) p.respond(orphaned(seconds));
        },
    };
}
