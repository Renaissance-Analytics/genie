import { describe, expect, it } from 'vitest';
import { createShuttleCore } from '../core';
import { createPublisherGate, type GateConnection, type GateMessage } from '../publisher-gate';

/**
 * WHO MAY PUBLISH — the shuttle's control-channel gate (§4.1, genie#346 Phase 1).
 *
 * The shuttle forwards every tool call an agent makes to whichever Genie is the
 * attached PUBLISHER, and serves the tool list that publisher declared. So the
 * publisher defines what every agent on the machine can call. The spec is blunt
 * about what that makes this file:
 *
 *   "This is load-bearing security, not hygiene. A shuttle that accepted any local
 *    publisher would let any process on the box redefine every tool every agent in
 *    Genie can call."
 *
 * The rules:
 *   - a connection must present the secret before it is anything;
 *   - exactly ONE publisher at a time;
 *   - a second AUTHENTICATED connection takes over — the new Genie is the live one,
 *     the old is being replaced — and the displaced one is told so and closed;
 *   - an incompatible wire generation is refused, by name.
 */

const SECRET = 'publisher-secret-0123456789abcdef';
const WIRE = 1;

/** A fake control-channel connection that records what the gate did to it. */
function connection(label: string) {
    const sent: GateMessage[] = [];
    let closed: string | null = null;
    const conn: GateConnection & { label: string } = {
        label,
        send: (m) => void sent.push(m),
        close: (reason) => void (closed = reason),
    };
    return { conn, sent, closed: () => closed };
}

function setup() {
    const core = createShuttleCore({ now: () => 0 });
    const gate = createPublisherGate({ secret: SECRET, wireGeneration: WIRE, core });
    return { core, gate };
}

const hello = (over: Partial<Extract<GateMessage, { type: 'hello' }>> = {}): GateMessage => ({
    type: 'hello',
    wireGeneration: WIRE,
    secret: SECRET,
    generation: 1,
    ...over,
});

describe('authentication', () => {
    it('attaches a connection that presents the right secret', () => {
        const { core, gate } = setup();
        const a = connection('genie');
        gate.connected(a.conn);
        gate.message(a.conn, hello());

        expect(core.state()).toBe('attached');
        expect(a.sent.at(-1)).toMatchObject({ type: 'welcome' });
        expect(a.closed()).toBeNull();
    });

    it('REFUSES a wrong secret, closes it, and attaches nothing', () => {
        const { core, gate } = setup();
        const intruder = connection('intruder');
        gate.connected(intruder.conn);
        gate.message(intruder.conn, hello({ secret: 'not-the-secret' }));

        expect(core.state()).toBe('detached');
        expect(intruder.closed()).not.toBeNull();
    });

    it('refuses a secret that differs only in LENGTH, without throwing', () => {
        // A naive timingSafeEqual throws on unequal-length buffers. A throw here
        // would take down the shuttle's control loop — a denial of service by
        // anyone who can open the pipe.
        const { core, gate } = setup();
        const c = connection('short');
        gate.connected(c.conn);
        expect(() => gate.message(c.conn, hello({ secret: 'x' }))).not.toThrow();
        expect(core.state()).toBe('detached');
        expect(c.closed()).not.toBeNull();
    });

    it('refuses anything that is not a hello from an unauthenticated connection', () => {
        // Order matters: a connection must not be able to act first and
        // authenticate later.
        const { core, gate } = setup();
        const c = connection('eager');
        gate.connected(c.conn);
        gate.message(c.conn, { type: 'result', correlationId: 1, response: { result: {} } });

        expect(core.state()).toBe('detached');
        expect(c.closed()).not.toBeNull();
    });

    it('refuses an incompatible wire generation, naming BOTH generations', () => {
        // A wire mismatch is the deep-upgrade condition from Phase 0. Refusing it
        // silently would read as a hung Genie; naming it says what to do.
        const { core, gate } = setup();
        const c = connection('future');
        gate.connected(c.conn);
        gate.message(c.conn, hello({ wireGeneration: WIRE + 1 }));

        expect(core.state()).toBe('detached');
        const reason = c.closed() ?? '';
        expect(reason).toContain(String(WIRE));
        expect(reason).toContain(String(WIRE + 1));
    });
});

describe('exactly one publisher', () => {
    it('lets a second AUTHENTICATED connection take over, and tells the old one', () => {
        // The swap: the old Genie is being replaced by the new one, which connects
        // before the old has fully gone.
        const { core, gate } = setup();
        const oldGenie = connection('old');
        const newGenie = connection('new');

        gate.connected(oldGenie.conn);
        gate.message(oldGenie.conn, hello({ generation: 1 }));
        gate.connected(newGenie.conn);
        gate.message(newGenie.conn, hello({ generation: 2 }));

        expect(core.state()).toBe('attached');
        expect(gate.publisher()).toBe(newGenie.conn);
        expect(oldGenie.sent.at(-1)).toMatchObject({ type: 'displaced' });
        expect(oldGenie.closed()).not.toBeNull();
        expect(newGenie.closed()).toBeNull();
    });

    it('does NOT let an UNAUTHENTICATED connection displace the publisher', () => {
        // The attack the gate exists to stop, stated directly: connecting must not
        // be enough to evict the real Genie.
        const { gate } = setup();
        const genie = connection('genie');
        const intruder = connection('intruder');

        gate.connected(genie.conn);
        gate.message(genie.conn, hello());
        gate.connected(intruder.conn);
        gate.message(intruder.conn, hello({ secret: 'guess' }));

        expect(gate.publisher()).toBe(genie.conn);
        expect(genie.closed()).toBeNull();
    });

    it('does not detach the publisher when some OTHER connection closes', () => {
        const { core, gate } = setup();
        const genie = connection('genie');
        const passerby = connection('passerby');

        gate.connected(genie.conn);
        gate.message(genie.conn, hello());
        gate.connected(passerby.conn);
        gate.closed(passerby.conn);

        expect(core.state()).toBe('attached');
        expect(gate.publisher()).toBe(genie.conn);
    });

    it('POSITIVE CONTROL — the publisher itself closing DOES detach', () => {
        // Without this, "another close does not detach" also passes for a gate
        // that never detaches at all.
        const { core, gate } = setup();
        const genie = connection('genie');
        gate.connected(genie.conn);
        gate.message(genie.conn, hello());
        gate.closed(genie.conn);

        expect(core.state()).toBe('detached');
        expect(gate.publisher()).toBeNull();
    });

    it('ignores a late close from a publisher that was already displaced', () => {
        // The old Genie's socket can close AFTER the new one has taken over. That
        // close belongs to a connection that is no longer the publisher, and
        // honouring it would detach the NEW Genie.
        const { core, gate } = setup();
        const oldGenie = connection('old');
        const newGenie = connection('new');

        gate.connected(oldGenie.conn);
        gate.message(oldGenie.conn, hello({ generation: 1 }));
        gate.connected(newGenie.conn);
        gate.message(newGenie.conn, hello({ generation: 2 }));
        gate.closed(oldGenie.conn);

        expect(core.state()).toBe('attached');
        expect(gate.publisher()).toBe(newGenie.conn);
    });
});

describe('results only count from the publisher', () => {
    it('drops a result frame from a connection that is not the publisher', () => {
        // Otherwise a displaced socket, or any other authenticated-then-replaced
        // connection, could answer a tool call the live Genie is still running.
        const { core, gate } = setup();
        const genie = connection('genie');
        gate.connected(genie.conn);
        gate.message(genie.conn, hello());

        const answers: unknown[] = [];
        core.call({ id: 1, method: 'tools/call' }, (r) => void answers.push(r));
        // The dispatch went out over the publisher's own connection, so its
        // correlation id is read from there — no test-only accessor on the gate.
        const dispatched = genie.sent.find((m) => m.type === 'dispatch');
        expect(dispatched).toBeDefined();
        const correlationId = (dispatched as Extract<GateMessage, { type: 'dispatch' }>).frame.correlationId;

        const stranger = connection('stranger');
        gate.connected(stranger.conn);
        gate.message(stranger.conn, { type: 'result', correlationId, response: { result: 'forged' } });

        expect(answers).toEqual([]);
    });

    it('POSITIVE CONTROL — the same result from the publisher IS delivered', () => {
        const { core, gate } = setup();
        const genie = connection('genie');
        gate.connected(genie.conn);
        gate.message(genie.conn, hello());

        const answers: unknown[] = [];
        core.call({ id: 1, method: 'tools/call' }, (r) => void answers.push(r));
        const dispatched = genie.sent.find((m) => m.type === 'dispatch') as Extract<
            GateMessage,
            { type: 'dispatch' }
        >;

        gate.message(genie.conn, {
            type: 'result',
            correlationId: dispatched.frame.correlationId,
            response: { result: 'real' },
        });

        expect(answers).toEqual([{ result: 'real' }]);
    });
});
