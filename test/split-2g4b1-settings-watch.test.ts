import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HUMAN } from '../src/core/inbox.js';
import { mailSignalsOfRead, mailSignalsOfSend, readMailSignal } from '../src/core/mail-actions.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { OWN_CLIENT_LABEL, type OwnCallAnswer } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import type { SettingValue, SettingsData } from '../src/main/settings-read.js';
import { EMPTY_SETTINGS_WATCH, readSettingsWatch, settingsWatchFeed, type SettingsWatchView } from '../src/main/settings-watch.js';
import { windowSettings } from '../src/main/window-settings.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4b1 (Tynn #998; part of #955, the coordinator's split of 2g-4b). The settings main reads reach it
 * over a local `settings.watch` that only main's own client may say, and its writes go over the one protocol. genie-host says
 * the mail sounds itself. The window registry's Deck, signals and handoff wiring is deleted once proven dead (main reads only
 * its agents and workspaces). And `deck.watch` and `summary.watch` are raised to main's own client only (the coordinator,
 * security), as `remote.watch` is.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

const DATA: SettingsData = { values: { do_not_disturb: true, start_minimized: false }, workspaces: { ws_a: { workspace_tabs: '[1]' } }, carriedOver: null };

describe('the protocol: settings.watch, heard on local-settings', () => {
    it('is a control method with its own local event', () => {
        expect(CONTROL_METHODS as readonly string[]).toContain('settings.watch');
        expect((LOCAL_EVENTS as Record<string, string>).settings).toBe('local-settings');
    });

    it('reads what genie-host said; anything that does not read is no settings (each read answers its default)', () => {
        const view: SettingsWatchView = { data: DATA, key: 'do_not_disturb', value: true, workspaceId: null };
        expect(readSettingsWatch(view)).toEqual(view);
        for (const bad of [null, 7, 'x', { data: 3 }, { data: { values: [] } }]) expect(readSettingsWatch(bad), JSON.stringify(bad)).toEqual(EMPTY_SETTINGS_WATCH);
    });

    it('the feed says the data now, then each change with what changed', () => {
        let data = DATA;
        let poke: (key: string, value: SettingValue, workspaceId?: string) => void = () => {};
        const feed = settingsWatchFeed({ data: () => data, onChange: (l) => { poke = l; return () => {}; } });
        expect(feed.now()).toEqual({ data: DATA, key: null, value: null, workspaceId: null });
        const heard: SettingsWatchView[] = [];
        feed.subscribe((v) => heard.push(v));
        data = { ...DATA, values: { ...DATA.values, do_not_disturb: false } };
        poke('do_not_disturb', false);
        poke('workspace_tabs', '[2]', 'ws_a');
        expect(heard).toEqual([{ data, key: 'do_not_disturb', value: false, workspaceId: null }, { data, key: 'workspace_tabs', value: '[2]', workspaceId: 'ws_a' }]);
    });
});

describe('genie-host says deck.watch, summary.watch and settings.watch to main’s own client, and to nobody else', () => {
    async function host(api: HostApi, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4b1-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }
    function api() {
        let emit: (channel: string, payload: unknown) => void = () => {};
        const a = {
            invoke: vi.fn(async (method: string) => (method === 'snapshot' ? { deck: [] } : null)),
            onEvent: (listener: (channel: string, payload: unknown) => void) => { emit = listener; return () => {}; },
            workspaceOfAgent: () => null,
            hostSummary: () => ({ terminals: [] }),
            settingsWatch: () => ({ data: DATA, key: null, value: null, workspaceId: null }),
        } as unknown as HostApi;
        return { api: a, emit: (channel: string, payload: unknown) => emit(channel, payload) };
    }
    const connector = () => {
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const transport: ServerTransport = { onConnection: (l) => { accept = l; return () => {}; } };
        const connect = async (preAuth: Record<string, unknown>) => {
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: preAuth as never });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: String(preAuth.label) }));
            await settle();
            const call = async (id: number, method: string, args: unknown[] = []) => {
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args }));
                await settle();
                return frames.find((m) => m.kind === 'result' && m.id === id) as Extract<WireMessage, { kind: 'result' }> | undefined;
            };
            return { frames, call, events: () => frames.filter((m) => m.kind === 'event') as Extract<WireMessage, { kind: 'event' }>[] };
        };
        return { transport, connect };
    };
    const OWN = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true };
    const PAGE = { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' };
    const TRAY_LABEL_ONLY = { ...PAGE, label: OWN_CLIENT_LABEL };
    const RELAY = { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false };

    it.each(['deck.watch', 'summary.watch', 'settings.watch'])('%s: a page in this machine’s window, one only labelled Genie’s tray, or another machine is refused; main’s own client is answered', async (method) => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            for (const preAuth of [PAGE, TRAY_LABEL_ONLY, RELAY]) {
                const other = await c.connect(preAuth);
                expect(await other.call(1, method), `${method} ${JSON.stringify(preAuth)}`).toMatchObject({ ok: false });
            }
            // CONTROL: main's own client is answered.
            const own = await c.connect(OWN);
            expect(await own.call(1, method)).toMatchObject({ ok: true });
        } finally { await h.done(); }
    });

    it('main’s own settings watcher hears local-settings and nothing else; no other connection hears it', async () => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            const own = await c.connect(OWN);
            expect(await own.call(1, 'settings.watch')).toMatchObject({ ok: true, value: { data: DATA, key: null } });
            const page = await c.connect(PAGE);
            const changed = { data: DATA, key: 'do_not_disturb', value: false, workspaceId: null };
            a.emit('local-settings', changed);
            a.emit('local-features', { revision: 2 });
            await settle();
            expect(own.events().map((e) => [e.channel, e.payload])).toEqual([['local-settings', changed]]);
            expect(page.events().map((e) => e.channel)).toContain('local-features');
            expect(page.events().map((e) => e.channel)).not.toContain('local-settings');
        } finally { await h.done(); }
    });
});

describe('main’s settings: read from the watch, written over the protocol', () => {
    function own() {
        const calls: Array<[string, unknown[]]> = [];
        let onView: (view: SettingsWatchView) => void = () => {};
        let answer: OwnCallAnswer = { ok: true, value: null };
        return {
            calls,
            refuse: (reason: string) => { answer = { ok: false, reason }; },
            say: (view: SettingsWatchView) => onView(view),
            client: {
                call: async (method: 'features.act' | 'workspaces.setSetting', args: unknown[]) => { calls.push([method, args]); return answer; },
                watchSettings: (l: (view: SettingsWatchView) => void) => { onView = l; return () => {}; },
            },
        };
    }

    it('before genie-host says anything every read is its default; then the host’s values, a workspace’s over them', () => {
        const o = own();
        const s = windowSettings(o.client);
        s.start();
        expect(s.snapshot().do_not_disturb).toBe(false);
        o.say({ data: DATA, key: null, value: null, workspaceId: null });
        expect(s.snapshot().do_not_disturb).toBe(true);
        // Started once, however often asked: one watch.
        s.start();
        o.say({ data: DATA, key: null, value: null, workspaceId: null });
        expect(s.snapshot().do_not_disturb).toBe(true);
        expect(s.snapshotFor('ws_a').workspace_tabs).toBe('[1]');
        expect(s.snapshotFor('ws_a').do_not_disturb).toBe(true);
    });

    it('HOT-SWAP: a change reaches the listener after the data, so it reads the new value; the first view is no change', () => {
        const o = own();
        const s = windowSettings(o.client);
        s.start();
        const heard: Array<[string, SettingValue, string | undefined, SettingValue]> = [];
        s.onChange((key, value, workspaceId) => heard.push([key, value, workspaceId, s.snapshot().do_not_disturb as SettingValue]));
        o.say({ data: DATA, key: null, value: null, workspaceId: null });
        const next = { ...DATA, values: { ...DATA.values, do_not_disturb: false } };
        o.say({ data: next, key: 'do_not_disturb', value: false, workspaceId: null });
        o.say({ data: next, key: 'workspace_tabs', value: '[2]', workspaceId: 'ws_a' });
        expect(heard).toEqual([['do_not_disturb', false, undefined, false], ['workspace_tabs', '[2]', 'ws_a', false]]);
    });

    it('a WHOLE view (genie-host saying all of its settings: the first, and each after a reconnect) is told to onView, after the data; a keyed change is not (P6-3)', () => {
        const o = own();
        const s = windowSettings(o.client);
        s.start();
        const heard: SettingValue[] = [];
        s.onView(() => heard.push(s.snapshot().launch_at_login as SettingValue));
        o.say({ data: { ...DATA, values: { launch_at_login: true } }, key: null, value: null, workspaceId: null });
        o.say({ data: { ...DATA, values: { launch_at_login: true, theme: 'dark' } }, key: 'theme', value: 'dark', workspaceId: null });
        o.say({ data: { ...DATA, values: { launch_at_login: false } }, key: null, value: null, workspaceId: null });
        expect(heard).toEqual([true, false]);
    });

    it('ready once genie-host has said them, so the boot reads start minimized and the login item as they are, not as defaults; a host that never says is waited for no longer than the deadline', async () => {
        const o = own();
        const s = windowSettings(o.client);
        s.start();
        let ready = false;
        void s.ready(1_000).then(() => { ready = true; });
        await settle();
        expect(ready).toBe(false);
        o.say({ data: { ...DATA, values: { start_minimized: true } }, key: null, value: null, workspaceId: null });
        await settle();
        expect(ready).toBe(true);
        expect(s.snapshot().start_minimized).toBe(true);
        const silent = windowSettings(own().client);
        silent.start();
        const at = Date.now();
        await silent.ready(30);
        expect(Date.now() - at).toBeLessThan(1_000);
        expect(silent.snapshot().start_minimized).toBe(false);
    });

    it('writes go to genie-host: a setting by features.act, a workspace’s by workspaces.setSetting; a refusal is said', async () => {
        const o = own();
        const s = windowSettings(o.client);
        s.start();
        await s.set('tray_notice_shown', true);
        await s.setFor('ws_a', 'workspace_tabs', '[3]');
        expect(o.calls).toEqual([['features.act', [{ kind: 'settings.set', key: 'tray_notice_shown', value: true }]], ['workspaces.setSetting', ['ws_a', 'workspace_tabs', '[3]']]]);
        o.refuse('Genie is still starting');
        await expect(s.set('launch_at_login', true)).rejects.toThrow('Genie is still starting');
    });
});

describe('genie-host says the mail sounds', () => {
    it('a message between agents: who sent it to whom, and the sender’s own sound; mail to or from the person or an app has no sound row', () => {
        expect(mailSignalsOfSend('a2', { id: 'm1', from: 'a1' as never, to: 'a2' as never })).toEqual([
            { agentId: 'a1', kind: 'mail-sent', to: 'a2', id: 'm1' }, { agentId: 'a1', kind: 'agentmail' },
        ]);
        expect(mailSignalsOfSend(HUMAN, { id: 'm2', from: 'a1' as never, to: HUMAN })).toEqual([{ agentId: 'a1', kind: 'mail-sent', to: HUMAN, id: 'm2' }]);
        expect(mailSignalsOfRead('a2', ['m1'])).toEqual([{ agentId: 'a2', kind: 'mail-read', ids: ['m1'] }]);
        expect(mailSignalsOfRead('a2', [])).toEqual([]);
        expect(mailSignalsOfRead('a2', null)).toEqual([]);
    });

    it('main passes on only what reads as one', () => {
        for (const good of [{ agentId: 'a1', kind: 'mail-sent', to: 'a2', id: 'm1' }, { agentId: 'a2', kind: 'mail-read', ids: ['m1'] }, { agentId: 'a1', kind: 'agentmail' }]) expect(readMailSignal(good)).toEqual(good);
        for (const bad of [null, { kind: 'mail-sent' }, { agentId: 'a1', kind: 'quit' }, { agentId: 'a2', kind: 'mail-read', ids: 'm1' }]) expect(readMailSignal(bad), JSON.stringify(bad)).toBeNull();
    });

    it('wired: genie-host says each on the tool-signal path; main hands on what reads', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/own\.inbox\.onSend\(\(to, message\) => \{ for \(const mail of mailSignalsOfSend\(to, message\)\) engine\.callback\(\{ name: 'toolSignal', signal: \{ kind: 'mail', mail \} \}\); \}\)/);
        expect(host).toMatch(/own\.inbox\.onRead\(\(reader, ids\) => \{ for \(const mail of mailSignalsOfRead\(reader, ids \? \[\.\.\.ids\] : null\)\) engine\.callback\(\{ name: 'toolSignal', signal: \{ kind: 'mail', mail \} \}\); \}\)/);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/signal\.kind === 'mail'\) \{ const mail = readMailSignal\(\(raw as \{ mail\?: unknown \}\)\.mail\); if \(mail\) broadcast\('genie:action', mail\); \}/);
        expect(main).not.toMatch(/composed\.inbox\.on(Send|Read)\(/);
    });
});

describe('the window registry’s Deck wiring is dead: main reads only its agents and workspaces', () => {
    const main = code(src('src/main/main.ts'));

    it('PROOF: every read of the window registry’s snapshot in main is its .agents or .workspaces, and its listeners take no snapshot', () => {
        const reads = [...main.matchAll(/registry[?!]?\.snapshot\(\)(\.(\w+))?/g)].map((m) => m[2] ?? '(whole)');
        // CONTROL: the scan finds the reads that are there.
        expect(reads.length).toBeGreaterThan(5);
        expect([...new Set(reads)].sort()).toEqual(['agents', 'workspaces']);
        // Each listener's own parameter list, read up to its arrow; every subscribe found by the plain pattern is one of them.
        const subscribes = [...main.matchAll(/registry[?!]?\.subscribe\(/g)];
        const listeners = [...main.matchAll(/registry[?!]?\.subscribe\(\s*(\([^)]*\))\s*=>/g)];
        expect(subscribes.length).toBeGreaterThan(0);
        expect(listeners).toHaveLength(subscribes.length);
        for (const l of listeners) expect(l[1], l[0]).toBe('()');
        // What main hands the registry to reads no snapshot, or only its workspaces.
        expect(code(src('src/main/mcp-callers.ts'))).not.toMatch(/\.snapshot\(\)/);
        expect(code(src('src/main/registry-refresh.ts'))).not.toMatch(/\.snapshot\(\)/);
        expect(code(src('src/main/workspace-color-host.ts'))).toMatch(/snapshot\(\): \{ readonly workspaces\?: readonly W\[\] \| null \| undefined \};/);
    });

    it('so main builds no Deck, signals or handoff into it, and no change of the stores touches it', () => {
        expect(main).not.toMatch(/registry\.(setDeckSource|setSignals|setHandoffProbe)\(/);
        expect(main).not.toMatch(/composed\.(signals|deckItems|attention|approvals\.onChange|flows\.onChange)\b|composed\.onFrontDoorChange\(\(\) => registry/);
    });

    it('PINNED: an error main caught never goes through the registry (the tray count it fed went with the client tray, L5)', () => {
        expect(main).not.toMatch(/refreshTrayWaiting/);
        // Directly: the window's own features said again at once (the in-app Deck), never the registry.
        expect(main).toMatch(/mainErrors\.onChange\(\(\) => \{ requestFeaturePush\(\); \}\);/);
        expect(main).not.toMatch(/mainErrors\.onChange\(\(\) => registry/);
    });
});

describe('wired: main’s settings are the watch’s; genie-host feeds it', () => {
    it('main reads and writes its settings through windowSettings over its own client, and leaves the update channel to genie-host', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/const settingsNow = windowSettings\(ownProtocol\);/);
        expect(main).toMatch(/tunnelDoor\(ownProtocol\.door, tunnelLinkOf\(agentEngineLink\.client\), \{ own: true \}\);\s*settingsNow\.start\(\);/);
        expect(main.indexOf('await settingsNow.ready(SETTINGS_BOOT_DEADLINE_MS);')).toBeLessThan(main.indexOf('mountMainWindow(true);'));
        expect(main.indexOf('mountMainWindow(true);')).toBeGreaterThan(-1);
        expect(main).not.toMatch(/(services\??|composed)\.settings\b/);
        expect(main).not.toMatch(/update_channel/);
        // CONTROL: genie-host follows the update channel itself.
        expect(code(src('src/main/genie-host.ts'))).toMatch(/if \(key === 'update_channel' && workspaceId === undefined\) updatesService\.setChannel\(channelFrom\(value\)\);/);
    });

    it('genie-host feeds settings.watch from its settings store, and its host API says it on local-settings', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/const settingsWatch = settingsWatchFeed\(\{ data: \(\) => settings\.data\(\), onChange: \(listener\) => settings\.onChange\(listener\) \}\);/);
        expect(code(src('src/main/host-api.ts'))).toMatch(/deps\.settingsWatch\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.settings, view\)\)/);
    });
});
