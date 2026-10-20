import type { RelaySocket } from '../src/main/relay-wire.js';

/**
 * THE TYNN RELAY, IN MEMORY — genie-cloud's `src/relay-server/server.ts` + `router.ts` + `registry.ts`, rule for rule:
 * host-hello → host-welcome (the hello judged by `verifyHost`, the Tynn enrollment verifier's job); member-hello →
 * no-host error, or member-welcome + a control `open {grant}` to the host; member frames stamped with the relay's own
 * sid; a host control close/error delivered then the session dropped; a member leaving → a control close to the host.
 */
export interface FakeSocket extends RelaySocket {
    readonly url: string;
    deliver(text: string): void;
    drop(): void;
}

export function fakeRelay(verifyHost: (hello: Record<string, unknown>) => string | null) {
    const log: string[] = [];
    const hosts = new Map<string, FakeSocket>();
    const sessions = new Map<string, { workstationId: string; member: FakeSocket }>();
    const helloOf = new Map<FakeSocket, string | null>();
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
                log.push(`host ${id} registered`);
                socket.deliver(JSON.stringify({ type: 'host-welcome', workstationId: id }));
                return;
            }
            const s = sessions.get(String(msg.sid));
            if (!s) return;
            s.member.deliver(text);
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
            socket.deliver(JSON.stringify({ type: 'member-welcome', sid: fresh }));
            host.deliver(JSON.stringify({ kind: 'open', channel: 'control', sid: fresh, payload: { grant: msg.grant } }));
            return;
        }
        // Stamp the authoritative sid: a member cannot speak for another session.
        hosts.get(sessions.get(sid)!.workstationId)?.deliver(JSON.stringify({ ...msg, sid }));
    };

    const onClosed = (socket: FakeSocket) => {
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
        const s: FakeSocket = {
            url,
            readyState: 0,
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            send: (data) => { if (!closed) queueMicrotask(() => onMessage(s, data)); },
            close: () => { s.drop(); },
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
    return { socket, log, hosts, sessions };
}


/** Let every queued frame land. */
export const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
