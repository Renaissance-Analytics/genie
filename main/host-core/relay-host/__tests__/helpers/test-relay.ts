import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A minimal relay BROKER for tests: `/ws/host` + `/ws/member`, routing frames
 * between one registered host and its member sessions — the wire behaviour of
 * genie-cloud's `startRelayServer`, without its enrollment verification (which is
 * genie-cloud's to test). It records every host-hello so a test can assert what the
 * desktop presented.
 */
export interface TestRelay {
    url: string;
    hellos: Array<Record<string, unknown>>;
    /** Close the host link (as a relay restart would). */
    dropHost(): void;
    close(): Promise<void>;
}

export async function startTestRelay(): Promise<TestRelay> {
    const hellos: Array<Record<string, unknown>> = [];
    const hosts = new Map<string, WebSocket>();
    const members = new Map<string, { ws: WebSocket; workstationId: string }>();
    let seq = 0;

    const server = http.createServer((_req, res) => {
        res.writeHead(426);
        res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/ws/host' && path !== '/ws/member') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => (path === '/ws/host' ? onHost(ws) : onMember(ws)));
    });

    function onHost(ws: WebSocket): void {
        let id: string | null = null;
        ws.on('message', (raw) => {
            if (!id) {
                const hello = JSON.parse(String(raw)) as Record<string, unknown>;
                hellos.push(hello);
                id = String(hello.workstationId);
                hosts.set(id, ws);
                ws.send(JSON.stringify({ type: 'host-welcome', workstationId: id }));
                return;
            }
            const frame = JSON.parse(String(raw)) as { sid: string };
            const member = members.get(frame.sid);
            if (member && member.ws.readyState === 1) member.ws.send(String(raw));
            const parsed = JSON.parse(String(raw)) as { channel?: string; kind?: string };
            if (parsed.channel === 'control' && parsed.kind === 'error') member?.ws.close();
        });
        ws.on('close', () => {
            if (id && hosts.get(id) === ws) hosts.delete(id);
            for (const [sid, m] of members) {
                if (m.workstationId === id) {
                    m.ws.close();
                    members.delete(sid);
                }
            }
        });
    }

    function onMember(ws: WebSocket): void {
        let sid: string | null = null;
        ws.on('message', (raw) => {
            if (!sid) {
                const hello = JSON.parse(String(raw)) as { workstationId: string; grant: string };
                const host = hosts.get(hello.workstationId);
                if (!host) {
                    ws.send(JSON.stringify({ type: 'error', code: 'no-host', reason: 'workstation not connected' }));
                    ws.close();
                    return;
                }
                sid = `ms_${++seq}`;
                members.set(sid, { ws, workstationId: hello.workstationId });
                ws.send(JSON.stringify({ type: 'member-welcome', sid }));
                host.send(JSON.stringify({ kind: 'open', channel: 'control', sid, payload: { grant: hello.grant } }));
                return;
            }
            const frame = JSON.parse(String(raw)) as Record<string, unknown>;
            const host = hosts.get(members.get(sid)!.workstationId);
            if (host && host.readyState === 1) host.send(JSON.stringify({ ...frame, sid }));
        });
        ws.on('close', () => {
            if (!sid) return;
            const host = hosts.get(members.get(sid)?.workstationId ?? '');
            members.delete(sid);
            if (host && host.readyState === 1) host.send(JSON.stringify({ kind: 'close', channel: 'control', sid }));
        });
    }

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `ws://127.0.0.1:${port}`,
        hellos,
        dropHost: () => {
            for (const ws of hosts.values()) ws.close();
        },
        close: () =>
            new Promise<void>((r) => {
                for (const ws of wss.clients) ws.terminate();
                wss.close();
                server.close(() => r());
            }),
    };
}
