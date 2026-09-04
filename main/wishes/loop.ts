/**
 * Loop prevention. A requirement, not a refinement.
 *
 * The owner's reference case moves a file, and moving a file CREATES a file. The
 * watcher reports that as a brand-new file with no idea who made it, the Wish
 * matches its own output, and the machine spends the night moving one file back
 * and forth. That is not a hypothetical failure mode; it is the default one.
 *
 * `raysonmeng/agent-bridge` solves the same problem in a different domain by
 * putting a `source` on every message. What generalises is the observation that
 * a loop is not a property of any single event — it is a property of the CHAIN
 * an event belongs to. So the chain is carried on the event, and three
 * independent rules read it. (Architectural reference only: nothing here vendors
 * or invokes that project.)
 *
 * ## Three rules, because one is not enough
 *
 *  1. **Self-source.** A Wish is never triggered by an event its own run caused.
 *     Direct self-loops, gone. Cheap, total, and useless against A → B → A.
 *  2. **Depth.** Every event a run emits is one step deeper than the event that
 *     triggered it. Past the limit the chain stops. This is what catches mutual
 *     recursion between Wishes that never see their own source.
 *  3. **The breaker.** Too many runs of one Wish in a rolling window and it is
 *     refused until the window clears. A backstop for the loop nobody predicted,
 *     including one that arrives through a path with no source at all.
 *
 * ## Why declared effects exist at all
 *
 * Rules 1 and 2 both need the event to CARRY the chain, and a filesystem event
 * carries nothing — it arrives milliseconds later from the operating system. So
 * a run declares what it is about to cause BEFORE it causes it, and
 * {@link WishLoopGuard.attribute} re-attributes the matching event when it shows
 * up. The event is re-attributed rather than dropped: another Wish may
 * legitimately care that the file moved, and deleting the event would hide a
 * real thing that really happened.
 *
 * A declared echo is consumed ONCE and expires. Both matter: a permanent
 * suppression on a path would mute the genuinely new file that lands there
 * tomorrow, and that failure is silent, which makes it worse than the loop.
 */

import type { WishDeclaredEffect, WishEvent, WishEventSource, WishPropValue } from './types';

export type WishLoopBlockCode = 'self-source' | 'max-depth' | 'rate-limit';

export type WishLoopDecision =
    | { ok: true }
    | { ok: false; code: WishLoopBlockCode; reason: string };

export interface WishLoopGuardOptions {
    /**
     * How many Wishes may fire in one causal chain. Three is enough for a
     * deliberate hand-off (a Wish that triggers a Wish that triggers a Wish) and
     * far short of anything that looks like recursion.
     */
    maxDepth?: number;
    /**
     * How long a declared effect waits for its echo. Generous, because the delay
     * is the operating system's: `fs.watch` latency plus the producer's own
     * de-duplication window. Too short reopens the loop; too long only delays
     * one legitimate re-fire on the same path.
     */
    echoWindowMs?: number;
    /** Breaker: runs of ONE Wish allowed inside {@link runWindowMs}. */
    maxRunsPerWindow?: number;
    runWindowMs?: number;
    now?: () => number;
}

interface DeclaredEcho extends WishDeclaredEffect {
    wishId: string;
    runId: string;
    declaredAt: number;
}

const DEFAULTS = {
    maxDepth: 3,
    echoWindowMs: 30_000,
    maxRunsPerWindow: 20,
    runWindowMs: 60_000,
} as const;

export class WishLoopGuard {
    private readonly maxDepth: number;
    private readonly echoWindowMs: number;
    private readonly maxRunsPerWindow: number;
    private readonly runWindowMs: number;
    private readonly now: () => number;

    private echoes: DeclaredEcho[] = [];
    private readonly runs = new Map<string, number[]>();

    constructor(opts: WishLoopGuardOptions = {}) {
        this.maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
        this.echoWindowMs = opts.echoWindowMs ?? DEFAULTS.echoWindowMs;
        this.maxRunsPerWindow = opts.maxRunsPerWindow ?? DEFAULTS.maxRunsPerWindow;
        this.runWindowMs = opts.runWindowMs ?? DEFAULTS.runWindowMs;
        this.now = opts.now ?? Date.now;
    }

    /**
     * Record an effect a run is ABOUT to cause. Call it before the write, never
     * after: the window between the write and the declaration is exactly the
     * window in which the loop happens.
     */
    declareEffect(effect: WishDeclaredEffect & { wishId: string; runId: string }): void {
        this.pruneEchoes();
        this.echoes.push({ ...effect, declaredAt: this.now() });
    }

    /**
     * Attach the causal chain to an event that arrived without one.
     *
     * Returns the event unchanged when nothing declared it. When a declared
     * effect matches, the echo is consumed and the event comes back attributed
     * to the run that caused it — which is what makes rules 1 and 2 able to see
     * a filesystem event they could otherwise know nothing about.
     */
    attribute(event: WishEvent): WishEvent {
        if (event.source.kind === 'wish') return event;
        this.pruneEchoes();

        const i = this.echoes.findIndex(
            (e) => e.event === event.event && propsMatch(e.match, event.props),
        );
        if (i < 0) return event;

        const [echo] = this.echoes.splice(i, 1);
        return {
            ...event,
            source: { kind: 'wish', wishId: echo.wishId, runId: echo.runId, depth: 1 },
        };
    }

    /** May `wishId` run for `event`? Every refusal names which rule refused it. */
    admit(wishId: string, event: WishEvent): WishLoopDecision {
        const source = event.source;

        if (source.kind === 'wish' && source.wishId === wishId) {
            return {
                ok: false,
                code: 'self-source',
                reason:
                    `"${wishId}" caused this event itself (run ${source.runId}), ` +
                    `so it is not retriggered by it.`,
            };
        }

        if (source.kind === 'wish' && source.depth >= this.maxDepth) {
            return {
                ok: false,
                code: 'max-depth',
                reason:
                    `this event is ${source.depth} Wishes deep in one chain ` +
                    `(the limit is ${this.maxDepth}), so the chain stops here.`,
            };
        }

        const recent = this.recentRuns(wishId);
        if (recent.length >= this.maxRunsPerWindow) {
            return {
                ok: false,
                code: 'rate-limit',
                reason:
                    `"${wishId}" has run ${recent.length} times in the last ` +
                    `${Math.round(this.runWindowMs / 1000)}s, which is its limit. ` +
                    `It is held until that window clears.`,
            };
        }

        return { ok: true };
    }

    /** Record that a run actually started. Only started runs count against the breaker. */
    noteRun(wishId: string): void {
        const recent = this.recentRuns(wishId);
        recent.push(this.now());
        this.runs.set(wishId, recent);
    }

    /**
     * The source the events of this run should carry: one step deeper than the
     * event that triggered it, or depth 1 when a human started it by hand.
     */
    sourceFor(wishId: string, runId: string, triggering: WishEvent | undefined): WishEventSource {
        const parentDepth =
            triggering && triggering.source.kind === 'wish' ? triggering.source.depth : 0;
        return { kind: 'wish', wishId, runId, depth: parentDepth + 1 };
    }

    private recentRuns(wishId: string): number[] {
        const cutoff = this.now() - this.runWindowMs;
        const kept = (this.runs.get(wishId) ?? []).filter((t) => t > cutoff);
        this.runs.set(wishId, kept);
        return kept;
    }

    private pruneEchoes(): void {
        const cutoff = this.now() - this.echoWindowMs;
        this.echoes = this.echoes.filter((e) => e.declaredAt > cutoff);
    }
}

/**
 * Whether every prop the effect DECLARED appears with that value on the event.
 *
 * A subset match on purpose: a mover knows the destination path it is about to
 * write, and nothing else about the event the watcher will produce — not the
 * size the OS will report, not the mtime, not which of several watchers sees it
 * first. Requiring an exact match would mean no echo ever matched.
 */
function propsMatch(
    declared: Readonly<Record<string, WishPropValue>>,
    actual: Readonly<Record<string, WishPropValue>>,
): boolean {
    for (const [key, value] of Object.entries(declared)) {
        if (actual[key] !== value) return false;
    }
    return true;
}
