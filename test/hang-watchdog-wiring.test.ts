import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/**
 * THE HEARTBEAT TRAVELS THE ENGINE LINK (Tynn story #386): window main → genie-host, a notification (no reply) every
 * second; the host's watchdog hears each beat by connection, and hears the connection drop. And the wiring in the two
 * entries: genie-host builds the watchdog and ends a frozen window; window main beats, and records its exit paths.
 */

const TOKEN = 'heartbeat-token';
const src = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('the heartbeat on the engine link', () => {
    it('a beat reaches the host’s watchdog by connection, with no reply; the link closing says dropped', async () => {
        const beats: Array<{ conn: string; beat: unknown }> = [];
        const dropped: string[] = [];
        const server = new SessionEngineServer({ token: TOKEN, build: 't', heartbeat: { beat: (conn, beat) => beats.push({ conn, beat }), dropped: (conn) => dropped.push(conn) } });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
        client.heartbeat({ pid: 4242, rss: 1024 });
        await vi.waitFor(() => expect(beats).toEqual([{ conn: expect.any(String), beat: { pid: 4242, rss: 1024 } }]));
        client.disconnect();
        await vi.waitFor(() => expect(dropped).toEqual([beats[0]!.conn]));
    });

    it('with no host linked, a beat is dropped quietly (never a throw from the timer)', () => {
        const client = new SessionEngineClient();
        expect(() => client.heartbeat({ pid: 1, rss: 1 })).not.toThrow();
    });
});

describe('the entries are wired', () => {
    it('genie-host builds the watchdog: it hears the engine link, writes into runtime/crash, ends a frozen window, survives', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/new HangWatchdog\(\{/);
        expect(host).toMatch(/kill: \(pid\) => killProcessAsync\(pid\)/);
        expect(host).toMatch(/writeCrashRecord\(join\(runtime, 'crash'\), record\)/);
        expect(host).toMatch(/heartbeat: hangWatchdog,/);
        // Every record's common header: the host's version and its build string.
        expect(host).toMatch(/header: \(\) => crashHeader\(build\.split\('\+'\)\[0\] \?\? build, build\),/);
        expect(host).toMatch(/hangWatchdog\.start\(\);/);
        // The host's own end is clean: the windows that drop with it are not lost. Still the first thing shutdown() does,
        // now inside the try whose finally gives back an upgrade's hold if the end does not happen (Tynn #616).
        expect(host).toMatch(/shuttingDown = true;\r?\n\s*try \{\r?\n\s*hangWatchdog\.shuttingDown\(\);/);
    });

    it('window main beats over the link and records every exit path it can catch', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/if \(launch\.kind === 'boot'\) crashRecorder\.install\(process, app\);/);
        expect(main).toMatch(/header: \(\) => crashHeader\(app\.getVersion\(\), agentEngineLink\?\.client\.welcome\?\.build \?\? app\.getVersion\(\)\),/);
        expect(main).toMatch(/startHeartbeat\(\{\s*send: \(beat\) => agentEngineLink\?\.client\.heartbeat\(beat\)/);
        // before-quit: after a cancelled quit and "just close the UI" have returned, before the shutdown runs.
        expect(main).toMatch(/if \(step === 'close-ui'\) \{[^\n]*\}\n\s*crashRecorder\.beforeQuit\(\);/);
        // A quit that ran to its end is clean: its record is taken back and the host told goodbye.
        expect(main).toMatch(/\.finally\(\(\) => \{ crashRecorder\.cleanQuit\(\); heartbeatNow\?\.bye\(\); app\.quit\(\); \}\);/);
    });
});
