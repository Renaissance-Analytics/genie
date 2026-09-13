import { describe, expect, it } from 'vitest';
import {
    PARK_CAP,
    SHUTTLE_ERROR_CODES,
    SWAP_GRACE_MS,
    createShuttleCore,
    type DispatchFrame,
    type ShuttleResponse,
} from '../core';

/**
 * THE SHUTTLE'S CORE: what an agent gets while Genie is being replaced.
 *
 * `.ai/plans/genie-mcp-shuttle-spec.md` §5, Phase 1 of genie#346. Pure — no process,
 * no socket, no HTTP. The transport is injected, so the one question the design
 * turns on can be asked directly:
 *
 *   "An agent calling a tool during the swap gets WHAT?"
 *
 * The spec's answer, which these tests pin: it WAITS, and if the wait is too long it
 * gets a truthful error naming the state. It is never told the tools are broken, and
 * it is never silently retried.
 *
 * ## The three states (§5.1)
 *
 *   Attached  — publisher connected        → calls forwarded
 *   Detached  — publisher gone < grace     → calls PARKED
 *   Orphaned  — publisher gone >= grace    → calls fail, named and honest
 */

/** A fake clock the core reads instead of Date.now(). */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** A fake publisher that records what it was sent. */
function publisher() {
    const frames: DispatchFrame[] = [];
    return { frames, dispatch: (f: DispatchFrame) => void frames.push(f) };
}

/** Collects every response the core hands back, keyed by the caller's request id. */
function responses() {
    const got = new Map<string | number, ShuttleResponse>();
    return {
        got,
        respond: (id: string | number) => (r: ShuttleResponse) => void got.set(id, r),
    };
}

const call = (id: number, name = 'manageSite') => ({
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
});

describe('attached — calls are forwarded', () => {
    it('dispatches a call to the publisher and returns its result on the same id', () => {
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        const pub = publisher();
        const r = responses();

        core.attach(pub, 1);
        core.call(call(7), r.respond(7));

        expect(pub.frames).toHaveLength(1);
        core.result(pub.frames[0]!.correlationId, { result: { content: [] } });
        expect(r.got.get(7)).toEqual({ result: { content: [] } });
    });

    it('reports its state honestly', () => {
        const core = createShuttleCore({ now: clock().now });
        expect(core.state()).toBe('detached'); // a cold shuttle is Detached, not broken
        core.attach(publisher(), 1);
        expect(core.state()).toBe('attached');
    });
});

describe('the swap — the common case is invisible', () => {
    it('PARKS a call that arrives while Genie is away, and delivers it on re-attach', () => {
        // §5.2 case 2: "Within the grace window the agent sees a slow call and
        // nothing else. This is the common case and it is invisible."
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        const oldGenie = publisher();
        const r = responses();

        core.attach(oldGenie, 1);
        core.detach();
        core.call(call(1), r.respond(1));

        // Nothing answered yet, and nothing sent to a publisher that is gone.
        expect(r.got.has(1)).toBe(false);
        expect(oldGenie.frames).toHaveLength(0);

        c.advance(5_000);
        const newGenie = publisher();
        core.attach(newGenie, 2);

        expect(newGenie.frames).toHaveLength(1);
        core.result(newGenie.frames[0]!.correlationId, { result: { ok: true } });
        expect(r.got.get(1)).toEqual({ result: { ok: true } });
    });

    it('delivers parked calls in ARRIVAL order', () => {
        const core = createShuttleCore({ now: clock().now });
        core.detach();
        const r = responses();
        for (const id of [1, 2, 3]) core.call(call(id), r.respond(id));

        const pub = publisher();
        core.attach(pub, 1);
        expect(pub.frames.map((f) => f.request.id)).toEqual([1, 2, 3]);
    });
});

describe('the one thing the shuttle must NEVER do: replay', () => {
    it('answers an IN-FLIGHT call with GenieSwapInterrupted when the publisher dies', () => {
        // §5.2 case 1: "The call is lost — its implementation died with the
        // process." Named and honest, so the agent can decide.
        const core = createShuttleCore({ now: clock().now });
        const oldGenie = publisher();
        const r = responses();

        core.attach(oldGenie, 1);
        core.call(call(1, 'provisionWorkspaces'), r.respond(1));
        expect(oldGenie.frames).toHaveLength(1); // dispatched, no result yet

        core.detach();

        expect(r.got.get(1)?.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieSwapInterrupted);
    });

    it('does NOT re-dispatch that interrupted call to the new Genie', () => {
        // The load-bearing rule. `manageProcess create`, `manageSite start` and
        // `provisionWorkspaces` are not idempotent — a silent replay could start a
        // second container or provision a second workspace. Only the agent knows
        // whether the call was safe to repeat, so only the agent may repeat it.
        const core = createShuttleCore({ now: clock().now });
        const r = responses();
        core.attach(publisher(), 1);
        core.call(call(1, 'provisionWorkspaces'), r.respond(1));
        core.detach();

        const newGenie = publisher();
        core.attach(newGenie, 2);

        expect(newGenie.frames).toHaveLength(0);
    });

    it('POSITIVE CONTROL — the new Genie DOES receive calls that were only parked', () => {
        // Without this, "the new Genie got nothing" also passes for a core that
        // drops everything on re-attach. The distinction under test is in-flight
        // (never replay) versus parked (always deliver).
        const core = createShuttleCore({ now: clock().now });
        const r = responses();
        core.attach(publisher(), 1);
        core.call(call(1), r.respond(1)); // in flight
        core.detach();
        core.call(call(2), r.respond(2)); // parked

        const newGenie = publisher();
        core.attach(newGenie, 2);

        expect(newGenie.frames.map((f) => f.request.id)).toEqual([2]);
    });

    it('ignores a late result for a call it already answered as interrupted', () => {
        // A result can race the disconnect. The agent has been told the call did
        // not complete; a second answer on the same id would contradict that.
        const core = createShuttleCore({ now: clock().now });
        const pub = publisher();
        const r = responses();
        core.attach(pub, 1);
        core.call(call(1), r.respond(1));
        const correlationId = pub.frames[0]!.correlationId;
        core.detach();

        core.result(correlationId, { result: { ok: true } });

        expect(r.got.get(1)?.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieSwapInterrupted);
    });
});

describe('the park queue is bounded', () => {
    it('evicts the OLDEST with GenieDetached once it is full, rather than growing', () => {
        // "a wedged Genie cannot make the shuttle grow without limit"
        const core = createShuttleCore({ now: clock().now });
        core.detach();
        const r = responses();

        for (let id = 1; id <= PARK_CAP + 1; id += 1) core.call(call(id), r.respond(id));

        // The first one was pushed out to make room, and told to retry.
        expect(r.got.get(1)?.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieDetached);
        // Everything that fits is still waiting, unanswered.
        expect(r.got.has(2)).toBe(false);
        expect(r.got.has(PARK_CAP + 1)).toBe(false);
    });

    it('holds exactly PARK_CAP before evicting anything', () => {
        const core = createShuttleCore({ now: clock().now });
        core.detach();
        const r = responses();
        for (let id = 1; id <= PARK_CAP; id += 1) core.call(call(id), r.respond(id));
        expect(r.got.size).toBe(0);
    });
});

describe('orphaned — Genie has been gone too long', () => {
    it('fails parked calls with GenieOrphaned once the grace window passes', () => {
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        core.attach(publisher(), 1);
        core.detach();
        const r = responses();
        core.call(call(1), r.respond(1));

        c.advance(SWAP_GRACE_MS);
        core.tick();

        expect(core.state()).toBe('orphaned');
        expect(r.got.get(1)?.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieOrphaned);
    });

    it('stays detached, still parking, just BEFORE the grace window passes', () => {
        // The boundary, on the other side — or "orphaned at grace" would also pass
        // for a core that orphans immediately.
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        core.attach(publisher(), 1);
        core.detach();
        const r = responses();
        core.call(call(1), r.respond(1));

        c.advance(SWAP_GRACE_MS - 1);
        core.tick();

        expect(core.state()).toBe('detached');
        expect(r.got.has(1)).toBe(false);
    });

    it('fails a NEW call immediately while orphaned, instead of parking it forever', () => {
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        core.detach();
        c.advance(SWAP_GRACE_MS);
        core.tick();

        const r = responses();
        core.call(call(9), r.respond(9));
        expect(r.got.get(9)?.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieOrphaned);
    });

    it('recovers when a Genie finally attaches', () => {
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        core.detach();
        c.advance(SWAP_GRACE_MS);
        core.tick();

        const pub = publisher();
        core.attach(pub, 1);
        const r = responses();
        core.call(call(1), r.respond(1));

        expect(core.state()).toBe('attached');
        expect(pub.frames).toHaveLength(1);
    });
});

describe('the errors name what is still true', () => {
    // §5.3: "Each names WHICH component is unavailable and what is still true.
    // The failure mode being designed out is a disconnect that reads as the tools
    // are broken."
    it('allocates from the implementation-defined range the spec leaves free', () => {
        for (const code of Object.values(SHUTTLE_ERROR_CODES)) {
            expect(code).toBeGreaterThanOrEqual(-32019);
            expect(code).toBeLessThanOrEqual(-32000);
        }
    });

    it('never tells the agent its tools are broken', () => {
        const c = clock();
        const core = createShuttleCore({ now: c.now });
        const r = responses();
        core.attach(publisher(), 1);
        core.call(call(1), r.respond(1));
        core.detach(); // interrupted
        for (let id = 2; id <= PARK_CAP + 2; id += 1) core.call(call(id), r.respond(id)); // evicts
        c.advance(SWAP_GRACE_MS);
        core.tick(); // orphaned

        const messages = [...r.got.values()].map((x) => x.error?.message ?? '');
        expect(messages.length).toBeGreaterThan(2);
        for (const m of messages) {
            expect(m).not.toMatch(/broken|unavailable tool|not found/i);
            expect(m).toMatch(/Genie/);
        }
    });
});
