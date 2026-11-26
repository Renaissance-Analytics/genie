import type { RelaySocket } from '../src/main/relay-wire.js';

/**
 * THE TYNN RELAY, IN MEMORY — genie-cloud's `src/relay-server/server.ts` + `router.ts` + `registry.ts`, rule for rule:
 * host-hello → host-welcome (the hello judged by `verifyHost`, the Tynn enrollment verifier's job); member-hello →
 * no-host error, or member-welcome + a control `open {grant}` to the host; member frames stamped with the relay's own
 * sid; a host control close/error delivered then the session dropped; a member leaving → a control close to the host;
 * and its HEARTBEAT (Tynn #940): every registered host is pinged every 30 s, which a `ws` socket surfaces as `'ping'`.
 */
export interface FakeSocket extends RelaySocket {
    readonly url: string;
    deliver(text: string): void;
    drop(): void;
    on(event: 'ping', listener: () => void): unknown;
    /** The relay's protocol ping, as `ws` surfaces it to the host: a `'ping'` event, never a message. */
    ping(): void;
}

/** genie-cloud's host heartbeat interval (`relay-server/server.ts` `heartbeatMs`). */
const HEARTBEAT_MS = 30_000;

/**
 * A RELAY THAT IS NOT HONEST (audit M-a, P9.2): what its operator could do with the frames it carries. Each hook gets one
 * routed frame (after the dial-in handshakes, the member's already stamped with its sid) and returns what is delivered
 * instead: `[text]` is honest, `[]` drops it, anything else rewrites, repeats or adds. Absent = honest.
 */
export interface RelayTamper {
    fromMember?(text: string, sid: string): string[];
    fromHost?(text: string, sid: string): string[];
}

export function fakeRelay(verifyHost: (hello: Record<string, unknown>) => string | null, tamper: RelayTamper = {}) {
    const log: string[] = [];
    /** Every frame this relay was handed, as it read it: what its operator sees. */
    const wire: Array<{ from: 'member' | 'host'; text: string }> = [];
    const hosts = new Map<string, FakeSocket>();
    const sessions = new Map<string, { workstationId: string; member: FakeSocket }>();
    const helloOf = new Map<FakeSocket, string | null>();
    const beats = new Map<FakeSocket, ReturnType<typeof setInterval>>();
    let nextSid = 0;

    const dropSession = (sid: string) => {
        const s = sessions.get(sid);
        if (!s) return;
        sessions.delete(sid);
        s.member.drop();
    };

    const onMessage = (socket: FakeSocket, text: string) => {
        const path = new URL(socket.url).pathname;
        const msg = JSON.parse(text) as Record<string, unknown>;
        if (path === '/ws/host') {
            if (helloOf.get(socket) === undefined) {
                const id = msg.type === 'host-hello' ? verifyHost(msg) : null;
                if (!id) { log.push('host refused'); socket.deliver(JSON.stringify({ type: 'error', code: 'enroll', reason: 'denied' })); socket.drop(); return; }
                helloOf.set(socket, id);
                hosts.set(id, socket);
                const beat = setInterval(() => { if (hosts.get(id) === socket) socket.ping(); else clearInterval(beat); }, HEARTBEAT_MS);
                beat.unref?.();
                beats.set(socket, beat);
                log.push(`host ${id} registered`);
                socket.deliver(JSON.stringify({ type: 'host-welcome', workstationId: id }));
                return;
            }
            const s = sessions.get(String(msg.sid));
            if (!s) return;
            wire.push({ from: 'host', text });
            for (const out of tamper.fromHost ? tamper.fromHost(text, String(msg.sid)) : [text]) s.member.deliver(out);
            if (msg.channel === 'control' && (msg.kind === 'close' || msg.kind === 'error')) dropSession(String(msg.sid));
            return;
        }
        // /ws/member
        const sid = [...sessions].find(([, s]) => s.member === socket)?.[0];
        if (!sid) {
            if (msg.type !== 'member-hello') { socket.drop(); return; }
            const host = hosts.get(String(msg.workstationId));
            if (!host) { socket.deliver(JSON.stringify({ type: 'error', code: 'no-host', reason: 'workstation not connected' })); socket.drop(); return; }
            const fresh = `sid_${++nextSid}`;
            sessions.set(fresh, { workstationId: String(msg.workstationId), member: socket });
            wire.push({ from: 'member', text });
            socket.deliver(JSON.stringify({ type: 'member-welcome', sid: fresh }));
            host.deliver(JSON.stringify({ kind: 'open', channel: 'control', sid: fresh, payload: { grant: msg.grant } }));
            return;
        }
        // Stamp the authoritative sid: a member cannot speak for another session.
        const stamped = JSON.stringify({ ...msg, sid });
        wire.push({ from: 'member', text: stamped });
        const host = hosts.get(sessions.get(sid)!.workstationId);
        for (const out of tamper.fromMember ? tamper.fromMember(stamped, sid) : [stamped]) host?.deliver(out);
    };

    const onClosed = (socket: FakeSocket) => {
        const beat = beats.get(socket);
        if (beat) clearInterval(beat);
        beats.delete(socket);
        const path = new URL(socket.url).pathname;
        if (path === '/ws/host') {
            const id = helloOf.get(socket);
            if (id && hosts.get(id) === socket) {
                hosts.delete(id);
                for (const [sid, s] of [...sessions]) if (s.workstationId === id) dropSession(sid);
            }
            return;
        }
        const sid = [...sessions].find(([, s]) => s.member === socket)?.[0];
        if (!sid) return;
        const s = sessions.get(sid)!;
        sessions.delete(sid);
        hosts.get(s.workstationId)?.deliver(JSON.stringify({ kind: 'close', channel: 'control', sid, reason: 'member left' }));
    };

    const socket = (url: string): FakeSocket => {
        let closed = false;
        const pings = new Set<() => void>();
        const s: FakeSocket = {
            url,
            readyState: 0,
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            send: (data) => { if (!closed) queueMicrotask(() => onMessage(s, data)); },
            close: () => { s.drop(); },
            on: (event, listener) => { if (event === 'ping') pings.add(listener); return s; },
            ping: () => { if (!closed) for (const l of pings) l(); },
            // As a real socket: what arrived before the close is delivered before it (the close is queued after).
            deliver: (text) => { if (!closed) queueMicrotask(() => s.onmessage?.({ data: text })); },
            drop: () => {
                if (closed) return;
                closed = true;
                (s as { readyState: number }).readyState = 3;
                queueMicrotask(() => { s.onclose?.({}); onClosed(s); });
            },
        };
        queueMicrotask(() => { if (closed) return; (s as { readyState: number }).readyState = 1; s.onopen?.({}); });
        return s;
    };
    /** The relay speaking for itself: a frame of its own making, to a session's host or to its member. */
    const toHost = (sid: string, text: string) => { const s = sessions.get(sid); if (s) hosts.get(s.workstationId)?.deliver(text); };
    const toMember = (sid: string, text: string) => { sessions.get(sid)?.member.deliver(text); };
    return { socket, log, hosts, sessions, wire, toHost, toMember };
}


/** Let every queued frame land. */
export const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
