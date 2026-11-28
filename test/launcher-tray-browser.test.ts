import { describe, expect, it } from 'vitest';
import { LAUNCHER_LINK_LABEL, LAUNCHER_LINK_METHODS } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { BrowserService } from '../src/main/browser-service.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

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

function rig() {
    const started: string[] = [];
    const browser = new BrowserService({ startBrowser: (launch) => { started.push(launch.file); } });
    browser.door(DOOR);
    void browser.call('publish', [{ launch: { file: '/genie/client/genie-client', args: ['--genie-browser'] } }], 'window-1');
    const server = new SessionEngineServer({ token: TOKEN, build: 't', browser });
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
