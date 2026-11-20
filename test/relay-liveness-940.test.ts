import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayHostLink, type RelayLinkState } from '../src/main/relay-host.js';
import { startRelayHost, type RelayHostStatus } from '../src/main/tynn-network.js';
import type { RelaySocket } from '../src/main/relay-wire.js';

/**
 * A SILENT RELAY IS NOTICED (Tynn #940). The owner's machines all read offline on the laptop while the desktop held a
 * 2.5-day-old ESTABLISHED socket to the relay: the relay had dropped it (no pong), the close never reached the desktop,
 * and the link — which redialled only on the OS close — sat on a dead half-open socket for good, logging nothing.
 *
 * The relay (genie-cloud `relay-server/server.ts`) sends a WebSocket PING every 30 s. `ws` answers it by itself and
 * emits `'ping'`, never a message, so a ping is life only if the link listens for it. The fake relay below pings the way
 * `ws` surfaces it, and can go SILENT WITHOUT CLOSING — the half-open socket — which is the case under test.
 */

interface FakeHostSocket extends RelaySocket {
    readonly url: string;
    terminated: boolean;
    closeCalls: number;
    on(event: 'ping', listener: () => void): unknown;
    terminate(): void;
    /** The relay's heartbeat, as `ws` surfaces it. */
    ping(): void;
    /** A routed frame from the relay (a member's traffic). */
    frame(text: string): void;
}

const HEARTBEAT_MS = 30_000;

/** The relay host end: welcomes any hello; pings every 30 s while `pinging`; `silent()` stops everything and never closes. */
function silentCapableRelay() {
    const sockets: FakeHostSocket[] = [];
    let pinging = true;
    const socket = (url: string): FakeHostSocket => {
        const pings = new Set<() => void>();
        const s: FakeHostSocket = {
            url,
            readyState: 0,
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            terminated: false,
            closeCalls: 0,
            send: (data) => {
                const msg = JSON.parse(data) as { type?: string };
                if (msg.type === 'host-hello' && pinging) queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ type: 'host-welcome', workstationId: 'ws_me' }) }));
            },
            // Half-open: the peer is gone, so a close handshake never completes and no `close` comes back.
            close: () => { s.closeCalls += 1; },
            // As `ws`: terminate destroys the socket, and its own `close` follows.
            terminate: () => {
                if (s.terminated) return;
                s.terminated = true;
                (s as { readyState: number }).readyState = 3;
                queueMicrotask(() => s.onclose?.({}));
            },
            on: (event, listener) => { if (event === 'ping') pings.add(listener); return s; },
            ping: () => { if (!s.terminated) for (const l of pings) l(); },
            frame: (text) => { if (!s.terminated) s.onmessage?.({ data: text }); },
        };
        queueMicrotask(() => { (s as { readyState: number }).readyState = 1; s.onopen?.({}); });
        sockets.push(s);
        return s;
    };
    const beat = setInterval(() => { if (pinging) sockets.at(-1)?.ping(); }, HEARTBEAT_MS);
    return {
        socket,
        sockets,
        silent: () => { pinging = false; },
        resume: () => { pinging = true; },
        stop: () => clearInterval(beat),
    };
}

const grantless = { validateGrant: async () => ({ ok: false as const, reason: 'no grants in this test' }), signedInHere: () => null };

function link(relay: ReturnType<typeof silentCapableRelay>, lines: string[], states: RelayLinkState[] = []) {
    return relayHostLink({
        socket: relay.socket,
        relayUrl: 'wss://relay.test',
        workstationId: 'ws_me',
        hello: async () => ({ type: 'host-hello', workstationId: 'ws_me', fingerprint: 'f', nonce: 'n', ts: 0, ticket: 't', sig: 's' }),
        ...grantless,
        revalidateMs: 0,
        reconnect: { minMs: 1_000, maxMs: 30_000 },
        log: (m) => lines.push(m),
        onState: (s) => states.push(s),
    });
}

describe('the relay host link notices a silent relay (Tynn #940)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('CONTROL: a relay that keeps pinging (pings only, no messages) is never redialled', async () => {
        const relay = silentCapableRelay();
        const lines: string[] = [];
        const l = link(relay, lines);
        l.connect();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(l.state()).toBe('open');
        expect(relay.sockets).toHaveLength(1);
        expect(relay.sockets[0]!.terminated).toBe(false);
        l.close();
        relay.stop();
    });

    it('CONTROL: member traffic is life too — a relay that only routes frames is not redialled', async () => {
        const relay = silentCapableRelay();
        const l = link(relay, []);
        l.connect();
        await vi.advanceTimersByTimeAsync(0); // welcomed; from here the relay never pings
        relay.silent();
        const traffic = setInterval(() => relay.sockets[0]!.frame(JSON.stringify({ kind: 'close', channel: 'control', sid: 'nobody' })), 20_000);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        clearInterval(traffic);
        expect(relay.sockets).toHaveLength(1);
        expect(l.state()).toBe('open');
        l.close();
        relay.stop();
    });

    it('a relay that goes silent WITHOUT closing: terminated and redialled within ~75 s, once', async () => {
        const relay = silentCapableRelay();
        const l = link(relay, []);
        l.connect();
        await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS); // two pings answered
        expect(l.state()).toBe('open');
        // The relay sends nothing more on THIS socket and never closes it; a new dial is welcomed and pinged again.
        relay.sockets[0]!.ping = () => {};
        const lastPingAt = Date.now();
        await vi.advanceTimersByTimeAsync(74_000 - (Date.now() - lastPingAt));
        expect(relay.sockets).toHaveLength(1);
        expect(relay.sockets[0]!.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(6_000); // 80 s after the last ping: 75 s silence + 1 s backoff, with room
        expect(relay.sockets[0]!.terminated).toBe(true);
        expect(relay.sockets).toHaveLength(2);
        expect(l.state()).toBe('open');
        // The old socket's own close (it follows terminate) does not dial a third time.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(relay.sockets).toHaveLength(2);
        l.close();
        relay.stop();
    });

    it('a relay that accepts the socket but never welcomes it is given up on in the same window', async () => {
        const relay = silentCapableRelay();
        relay.silent(); // no welcome, no pings
        const l = link(relay, []);
        l.connect();
        await vi.advanceTimersByTimeAsync(74_000);
        expect(relay.sockets).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(relay.sockets[0]!.terminated).toBe(true);
        expect(relay.sockets.length).toBeGreaterThanOrEqual(2);
        l.close();
        relay.stop();
    });

    it('says open, closed and redial, with the reason, in the log', async () => {
        const relay = silentCapableRelay();
        const lines: string[] = [];
        const l = link(relay, lines);
        l.connect();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
        expect(lines).toContain('open (wss://relay.test)');
        relay.sockets[0]!.ping = () => {};
        await vi.advanceTimersByTimeAsync(80_000);
        expect(lines).toContain('closed (the relay sent nothing for 75 s)');
        expect(lines).toContain('redial in 1 s (the relay sent nothing for 75 s)');
        expect(lines.filter((m) => m.startsWith('open ('))).toHaveLength(2);
        l.close();
        relay.stop();
    });

    it('a relay that closes the link: said, with the redial', async () => {
        const relay = silentCapableRelay();
        const lines: string[] = [];
        const l = link(relay, lines);
        l.connect();
        await vi.advanceTimersByTimeAsync(1_000);
        relay.sockets[0]!.onclose?.({});
        await vi.advanceTimersByTimeAsync(0);
        expect(lines).toContain('closed (the relay closed the link)');
        expect(lines).toContain('redial in 1 s (the relay closed the link)');
        l.close();
        relay.stop();
    });
});

describe('the link state reaches the status Settings shows (Tynn #940)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('reachable, then "reconnecting since <when the link was lost>" with the reason, then reachable again', async () => {
        const relay = silentCapableRelay();
        const key = generateKeyPairSync('ed25519');
        const statuses: RelayHostStatus[] = [];
        const host = startRelayHost({
            signedInHere: () => null,
            ports: { ticket: async () => ({ ticket: 't1', relayEndpoint: 'wss://relay.test' }), keys: async () => [], introspect: async () => false },
            socket: relay.socket,
            workstationId: 'ws_me',
            fingerprint: 'f',
            sign: (d) => sign(null, d, key.privateKey),
            onStatus: (s) => statuses.push(s),
            reconnect: { minMs: 5_000, maxMs: 30_000 },
        });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
        expect(host.status()).toEqual({ state: 'reachable', relay: 'wss://relay.test' });
        relay.sockets[0]!.ping = () => {};
        relay.silent(); // the redial is not welcomed yet
        const lostAt = Date.now() + 75_000;
        await vi.advanceTimersByTimeAsync(77_000);
        expect(host.status()).toEqual({ state: 'reconnecting', since: lostAt, reason: 'the relay sent nothing for 75 s' });
        // Dialling again keeps saying since when: it is not a fresh "connecting".
        expect(statuses.at(-1)).toEqual({ state: 'reconnecting', since: lostAt, reason: 'the relay sent nothing for 75 s' });
        relay.resume();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(host.status()).toEqual({ state: 'reachable', relay: 'wss://relay.test' });
        host.stop();
        relay.stop();
    });
});
