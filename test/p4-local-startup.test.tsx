import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { NO_FILES, pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { App } from '../src/renderer/App.js';

// The controller is part of the proposed page composition; no product scaffold precedes this red.
interface LocalControl {
    state(): { phase: 'starting' | 'ready' | 'failed'; reason: string | null; revision: number };
    onState(listener: () => void): () => void;
    retry(): void;
}
const control = (bridge: GenieBridge) => (bridge as GenieBridge & { localProtocol?: LocalControl }).localProtocol;

function fixture(refusals: number, reason = 'Genie is still starting') {
    let attempts = 0;
    let stopped = 0;
    let settingReads = 0;
    const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
    const active = new Set<string>();
    const port: LocalFramePort = {
        onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        send: (action, handle, text) => {
            if (action === 'open') { attempts++; active.add(handle); return; }
            if (action === 'close') { active.delete(handle); stopped++; return; }
            const frame = JSON.parse(text) as { kind: string; id: number; method: string; args: unknown[] };
            queueMicrotask(() => {
                const emit = (value: unknown) => { for (const listener of listeners) listener('frame', handle, JSON.stringify(value)); };
                if (frame.kind === 'hello') {
                    if (attempts <= refusals) {
                        emit({ kind: 'refused', reason }); active.delete(handle);
                        for (const listener of listeners) listener('closed', handle, '');
                    } else emit({ kind: 'welcome', connectionId: handle, host: 'this Genie', isOwner: true, workspaceId: null });
                } else {
                    expect(frame.method).toBe('workspaces.settings');
                    expect(frame.args).toEqual(['work']);
                    settingReads++;
                    emit({ kind: 'result', id: frame.id, ok: true, value: { ok: true, values: { workspace_tabs: '{"tabs":[]}' }, overridden: [] } });
                }
            });
        },
    };
    vi.stubGlobal('window', { genieLocalProtocol: port });
    const snapshot = vi.fn(async () => ({ workspaces: null }));
    const hibernate = vi.fn(async () => ({ ok: false, reason: 'agent still working' }));
    const oldSettings = vi.fn(async () => ({ ok: true, values: {}, overridden: [] }));
    const preload = { snapshot, subscribeAgentWire: () => () => {}, workspaces: { settings: oldSettings }, takeOver: hibernate } as unknown as PreloadBridge;
    const bridge = pageBridge(preload);
    return { bridge, preload, snapshot, hibernate, oldSettings, attempts: () => attempts, active: () => active.size,
        listenerCount: () => listeners.size, settingReads: () => settingReads, stopped: () => stopped,
        allow: () => { refusals = -1; },
        close: () => { for (const handle of active) for (const listener of listeners) listener('closed', handle, ''); active.clear(); },
    };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the local page connection retries only a bounded starting refusal', () => {
    it('main attaches the door after the late-bound services are assigned, so composition cannot welcome a call too early', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        const ready = main.indexOf('services = composed;');
        const attach = main.indexOf('remoteHub.add(localDoor);');
        expect(ready).toBeGreaterThan(0);
        expect(attach).toBeGreaterThan(0);
        expect(attach).toBeGreaterThan(ready);
    });
    it('refused twice then welcomed: queues the moved read, preserves bridge identity and all unmoved calls', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const f = fixture(2);
        const pending = f.bridge.workspaces.settings('work');
        await Promise.resolve(); await Promise.resolve();
        expect(f.attempts()).toBe(1);
        expect(await f.bridge.takeOver('work')).toEqual({ ok: false, reason: 'agent still working' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await pending).toMatchObject({ ok: true, values: { workspace_tabs: '{"tabs":[]}' } });
        expect(f.attempts()).toBe(3);
        expect(f.active()).toBe(1);
        expect(f.listenerCount()).toBe(1);
        expect(f.settingReads()).toBe(1);
        expect(f.oldSettings).not.toHaveBeenCalled();
        expect(f.hibernate).toHaveBeenCalledExactlyOnceWith('work');
        expect(pageBridge(f.preload)).toBe(f.bridge);
        expect(control(f.bridge)?.state()).toMatchObject({ phase: 'ready', reason: null, revision: 0 });
        f.close();
    });

    it('stops past the limit with the exact reason; explicit Retry recovers without replacing the bridge', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const f = fixture(Infinity);
        const pending = f.bridge.workspaces.settings('work');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toEqual({ ok: false, reason: 'Genie is still starting' });
        expect(f.attempts()).toBeGreaterThan(1);
        expect(f.attempts()).toBeLessThanOrEqual(6);
        expect(f.active()).toBe(0);
        expect(f.listenerCount()).toBe(0);
        const attempts = f.attempts();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.attempts()).toBe(attempts);
        expect(await f.bridge.takeOver('work')).toEqual({ ok: false, reason: 'agent still working' });
        const local = control(f.bridge);
        expect(local).toBeDefined();
        expect(local!.state()).toEqual({ phase: 'failed', reason: 'Genie is still starting', revision: 0 });
        const changed = vi.fn(); const off = local!.onState(changed);
        f.allow(); local!.retry();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(local!.state()).toEqual({ phase: 'ready', reason: null, revision: 1 });
        expect(changed).toHaveBeenCalled();
        expect(pageBridge(f.preload)).toBe(f.bridge);
        expect(await f.bridge.workspaces.settings('work')).toMatchObject({ ok: true });
        expect(f.settingReads()).toBe(1);
        expect(f.oldSettings).not.toHaveBeenCalled();
        expect(f.hibernate).toHaveBeenCalledTimes(1);
        off(); f.close();
    });

    it('a non-startup refusal is shown after one attempt and does not run an automatic retry loop', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const f = fixture(Infinity, 'this window is not admitted');
        const pending = f.bridge.workspaces.settings('work');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toEqual({ ok: false, reason: 'this window is not admitted' });
        expect(f.attempts()).toBe(1);
        expect(f.active()).toBe(0);
        expect(f.listenerCount()).toBe(0);
        f.close();
    });

    it('the desktop renders the refusal and Retry while its ordinary shell remains visible', () => {
        vi.stubGlobal('window', undefined);
        const bridge = {
            workspaces: {},
            files: NO_FILES,
            localProtocol: { state: () => ({ phase: 'failed', reason: 'Genie is still starting', revision: 0 }), onState: () => () => {}, retry: vi.fn() },
        } as unknown as GenieBridge;
        const html = renderToStaticMarkup(<App bridge={bridge} />);
        const alert = html.match(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/)?.[1];
        expect(alert).toContain('Genie is still starting');
        expect(alert).toMatch(/<button\b[^>]*>[\s\S]*?Retry[\s\S]*?<\/button>/);
        expect(html).toContain('Dashboard');
    });
});
