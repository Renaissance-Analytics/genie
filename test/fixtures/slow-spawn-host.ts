/**
 * A SPAWN HOST WHOSE SPAWNER TAKES 5 s (test/spawn-host-responsive.test.ts, genie#1397). The real protocol server
 * (main/spawn-host-server.ts) over a spawner that holds this child's thread SLOW_SPAWN_MS per process, the way a
 * synchronous CreateProcess under load does: Docker answers that the container is running; a pty reports pid 4242,
 * prints "hello", and exits 0 when killed.
 */
import { writeFileSync } from 'node:fs';
import { processChannel } from '../../src/main/spawn-host-protocol.js';
import { serveSpawnHost } from '../../src/main/spawn-host-server.js';
import type { PtyPort } from '../../src/main/terminal-host.js';

const SLOW = Number(process.env['SLOW_SPAWN_MS'] ?? '5000');
const hold = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* held */ } };

const data = new Set<(id: string, d: string) => void>();
const exits = new Set<(id: string, code: number) => void>();
let n = 0;
const pty: PtyPort = {
    open: () => {
        hold(SLOW);
        n += 1;
        const id = `engine_${n}`;
        setImmediate(() => { for (const l of data) l(id, 'hello\n'); });
        return { id, pid: 4242, shell: 'php-cgi', scrollback: '' };
    },
    write: () => true,
    resize: () => true,
    kill: (id) => { setImmediate(() => { for (const l of exits) l(id, 0); }); return true; },
    scrollback: () => '',
    onData: (l) => { data.add(l); return () => data.delete(l); },
    onExit: (l) => { exits.add(l); return () => exits.delete(l); },
};

const channel = processChannel(process);
/**
 * EXEC_NEVER_ANSWERS=<path>: a call that stays in flight for certain (test/spawn-host-client.test.ts). The exec writes the
 * marker when the call reaches it, then never answers, so a test can kill this child with the call provably waiting.
 */
const NEVER_ANSWERS = process.env['EXEC_NEVER_ANSWERS'];

serveSpawnHost(channel, {
    exec: async () => {
        if (NEVER_ANSWERS) {
            writeFileSync(NEVER_ANSWERS, String(process.pid));
            return new Promise<never>(() => { /* in flight until this child dies */ });
        }
        hold(SLOW);
        const stdout = '[{"State":{"Status":"running","StartedAt":"2026-11-01T00:00:00Z"}}]';
        return { stdout, exitCode: 0, streams: { stdout, stderr: '' } };
    },
    stream: () => ({ stop: () => {} }),
    pty,
});
channel.onClose(() => process.exit(0));
channel.onFrame((f) => { if (f.kind === 'call' && f.method === 'host.shutdown') setTimeout(() => process.exit(0), 50); });
