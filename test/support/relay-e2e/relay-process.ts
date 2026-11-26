import { appendFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A RELAY AS A PROCESS, FOR THE REAL-PROCESS ROW (audit M-a, P9.2; test/relay-e2e-process.test.ts). genie-cloud's
 * relay rules (the same ones test/relay-fake.ts follows) on real WebSockets: host-hello → host-welcome; member-hello →
 * no-host, or member-welcome and a control `open {grant}` to the host; a member's frames stamped with the relay's own
 * session id; a host's control close/error delivered, then the session dropped; a member leaving → a control close.
 *
 * It keeps what a relay operator could keep: EVERY frame it is handed, appended to the file named in argv[2], one JSON
 * line each (`{from, text}`). The test reads that file. It does not check the host's ticket (that is the relay's own
 * door, not what this row is about).
 */
const logFile = process.argv[2];
if (!logFile) throw new Error('usage: relay-process <log file>');
const keep = (from: 'member' | 'host', text: string): void => appendFileSync(logFile, `${JSON.stringify({ from, text })}\n`);

const hosts = new Map<string, WebSocket>();
const sessions = new Map<string, { workstationId: string; member: WebSocket }>();
let nextSid = 0;

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('connection', (socket, request) => {
    const path = new URL(request.url ?? '/', 'ws://relay').pathname;
    let hostOf: string | null = null;
    let sid: string | null = null;
    socket.on('error', () => {});
    socket.on('message', (raw) => {
        const text = String(raw);
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }
        if (path === '/ws/host') {
            if (hostOf === null) {
                if (msg.type !== 'host-hello' || typeof msg.workstationId !== 'string') { socket.close(); return; }
                hostOf = msg.workstationId;
                hosts.set(hostOf, socket);
                socket.send(JSON.stringify({ type: 'host-welcome', workstationId: hostOf }));
                return;
            }
            keep('host', text);
            const s = sessions.get(String(msg.sid));
            if (!s) return;
            s.member.send(text);
            if (msg.channel === 'control' && (msg.kind === 'close' || msg.kind === 'error')) { sessions.delete(String(msg.sid)); s.member.close(); }
            return;
        }
        if (path !== '/ws/member') { socket.close(); return; }
        if (sid === null) {
            if (msg.type !== 'member-hello') { socket.close(); return; }
            keep('member', text);
            const host = hosts.get(String(msg.workstationId));
            if (!host) { socket.send(JSON.stringify({ type: 'error', code: 'no-host', reason: 'workstation not connected' })); socket.close(); return; }
            sid = `sid_${++nextSid}`;
            sessions.set(sid, { workstationId: String(msg.workstationId), member: socket });
            socket.send(JSON.stringify({ type: 'member-welcome', sid }));
            host.send(JSON.stringify({ kind: 'open', channel: 'control', sid, payload: { grant: msg.grant } }));
            return;
        }
        const stamped = JSON.stringify({ ...msg, sid });
        keep('member', stamped);
        const s = sessions.get(sid);
        if (s) hosts.get(s.workstationId)?.send(stamped);
    });
    socket.on('close', () => {
        if (hostOf !== null && hosts.get(hostOf) === socket) {
            hosts.delete(hostOf);
            for (const [id, s] of [...sessions]) if (s.workstationId === hostOf) { sessions.delete(id); s.member.close(); }
        }
        if (sid !== null && sessions.get(sid)?.member === socket) {
            const s = sessions.get(sid)!;
            sessions.delete(sid);
            hosts.get(s.workstationId)?.send(JSON.stringify({ kind: 'close', channel: 'control', sid, reason: 'member left' }));
        }
    });
});
server.on('listening', () => {
    const address = server.address();
    console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`);
});
