import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCHER_LINK_LABEL, LAUNCHER_LINK_METHODS } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { BrowserService } from '../src/main/browser-service.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { hostBrowserStart } from '../src/main/host-browser-start.js';

/*
 * THE TRAY'S "OPEN GENIE BROWSER" ASKS THE HOST TO OPEN IT (Tynn #1058). Measured in the launcher-install row's end-to-end
 * check (Azure item 1128-033640-233be4, Linux): the tray started `genie-client --genie-browser` itself, with nothing to
 * open, and the Browser showed no window (browser-process.ts opens one only for an `open` the host says, and quits after
 * 60 s with none). The tray now asks the host, as a window's Browser row does: `engine.browser open [null, user-gesture]`,
 * which the host holds and starts the Browser for through the launcher (launcher.startBrowser, L4), or says to the running
 * one. The launcher's link may ask the browser service for `open` and nothing else.
 */
const TOKEN = 'tray-browser';
const DOOR = { frontDoorPort: 4443, caPem: 'CA', hosts: ['shop.gen'], workspaceOf: { 'shop.gen': 'ws_a' }, siteLabels: { 'shop.gen': 'Shop' } };

let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-tray-browser-')); });
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const noDriver: DriverFor = () => (() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get running() { return false; }, get cliSessionId() { return null; } })) as unknown as SessionDriverFactory;

/** genie-host's engine server as it runs: its session host attached, a browser service whose door is up and launch said. */
function rig() {
    const started: string[] = [];
    const browser = new BrowserService({ startBrowser: (launch) => { started.push(launch?.file ?? 'no launch'); } });
    browser.door(DOOR);
    void browser.call('publish', [{ launch: { file: '/genie/client/genie-client', args: ['--genie-browser'] } }], 'window-1');
    const server = new SessionEngineServer({ token: TOKEN, build: 't', browser });
    const host = new SessionHost({ userData: dir, driverFor: noDriver, processTree: tree });
    hosts.push(host);
    server.attach(host);
    return { server, started };
}

/** A link with the launcher's label (as native/launcher/src/host.rs says it), spoken in raw frames. */
async function launcherLink(server: SessionEngineServer) {
    const [h, w] = memoryPair();
    server.accept(h, { local: true });
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    w.onMessage((text) => { frames.push(JSON.parse(text) as Record<string, unknown>); for (const f of waiters.splice(0)) f(); });
    const next = async (match: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 200; i++) {
            const at = frames.findIndex(match);
            if (at >= 0) return frames.splice(at, 1)[0]!;
            await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 10); });
        }
        throw new Error('no frame');
    };
    w.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: TOKEN }, label: LAUNCHER_LINK_LABEL }));
    expect(await next((f) => f.kind === 'welcome' || f.kind === 'refused')).toMatchObject({ kind: 'welcome' });
    let id = 0;
    const call = async (method: string, args: unknown[]) => {
        id += 1;
        const mine = id;
        w.send(JSON.stringify({ kind: 'call', id: mine, method, args }));
        return next((f) => f.kind === 'result' && f.id === mine);
    };
    return { call };
}

describe('the tray’s "Open Genie Browser" over the launcher’s link', () => {
    it('engine.browser is a method the launcher’s link may call', () => {
        expect(LAUNCHER_LINK_METHODS).toContain('engine.browser');
    });

    it('open, as the person’s gesture: held for a Browser, which the host starts (through the launcher when there is one)', async () => {
        const r = rig();
        const link = await launcherLink(r.server);
        const answer = await link.call('engine.browser', ['open', [null, 'user-gesture']]);
        expect(answer).toMatchObject({ ok: true, value: { browserUp: false } });
        expect(r.started).toEqual(['/genie/client/genie-client']);
    });

    it('anything else of the browser service is refused to the launcher, in words', async () => {
        const r = rig();
        const link = await launcherLink(r.server);
        for (const method of ['publish', 'pages', 'pageCall', 'whoami']) {
            const answer = await link.call('engine.browser', [method, []]);
            expect(answer).toMatchObject({ ok: false });
            expect(String(answer.reason)).toBe(`Genie’s launcher may not ask the browser for ${method}.`);
        }
        expect(r.started).toEqual([]);
    });
});

/*
 * A HOST NO CLIENT WINDOW HAS SPOKEN TO (Tynn #1058, step 6 of the launch check). Measured: Azure item 1128-045257-b95ba6,
 * Linux: the host stopped and started from the tray with the UI closed, the tray's "Open Genie Browser" asked it
 * (`{"browserUp":false}`, held) and no Browser started in 45 s. Its BrowserService started a Browser only once a window had
 * published how (`launch`), which the launcher never needs: it starts the Browser's verified build itself. With a
 * launcher to start it, a held open starts the Browser with no window's launch; with neither, nothing is started.
 */
describe('a Browser with no window’s launch, when the launcher starts it', () => {
    it('a held open starts the Browser with no launch when the starter can do without one (the launcher is there)', async () => {
        const started: unknown[] = [];
        const service = new BrowserService({ startBrowser: (launch) => { started.push(launch); }, startsWithoutLaunch: () => true });
        service.door(DOOR);
        await service.call('open', [null, 'user-gesture'], 'genie launcher');
        expect(started).toEqual([null]);
    });

    it('CONTROL: with no launcher to start it, a held open still waits for a window to say how', async () => {
        const started: unknown[] = [];
        const service = new BrowserService({ startBrowser: (launch) => { started.push(launch); }, startsWithoutLaunch: () => false });
        service.door(DOOR);
        await service.call('open', [null, 'user-gesture'], 'genie launcher');
        expect(started).toEqual([]);
    });

    it('hostBrowserStart with no launch: asks the launcher when it is there', async () => {
        const asked: string[] = [];
        const spawned: string[] = [];
        const start = hostBrowserStart({ launcher: { reachable: () => true, call: async (m) => { asked.push(m); return { ok: true, value: { pid: 5 } }; } }, here: (l) => { spawned.push(l.file); }, log: () => {} });
        await start(null);
        expect(asked).toEqual(['launcher.startBrowser']);
        expect(spawned).toEqual([]);
    });

    it('hostBrowserStart with no launch and no launcher: starts nothing, and says why', async () => {
        const lines: string[] = [];
        const spawned: string[] = [];
        const start = hostBrowserStart({ launcher: { reachable: () => false, call: async () => ({ ok: true, value: null }) }, here: (l) => { spawned.push(l.file); }, log: (l) => lines.push(l) });
        await start(null);
        expect(spawned).toEqual([]);
        expect(lines.join('\n')).toContain('no launcher, and no window has said how to start it');
    });

    it('genie-host says its BrowserService may start the Browser without a window’s launch while the launcher is reachable', () => {
        const src = readFileSync(join('src', 'main', 'genie-host.ts'), 'utf8');
        expect(src).toContain('startBrowser: (launch) => { void startBrowserNow(launch); }, startsWithoutLaunch: () => launcherReachable(launcher) });');
    });
});
