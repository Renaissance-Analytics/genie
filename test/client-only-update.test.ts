import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostDecision, ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { classifyUpdate, hostHashOf } from '../src/core/update-kind.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { UpdatesService, type UpdaterEvent } from '../src/main/updates-host.js';
import { feedHostIdentity } from '../scripts/feed-host-identity.mjs';

/**
 * A CLIENT-ONLY UPDATE LEAVES THE HOST AND ITS AGENTS RUNNING (Tynn #413, host split P6). The release feed says which
 * genie-host it carries (`genieHostHash`, `genieEngineProtocol`, additive keys in latest*.yml). An update whose host is the
 * one running, by hash and protocol (never by version), changes only the window: the agents are not drained, nothing
 * hosted is stopped, genie-host does not exit, and the new window adopts it. Missing or unknown means a full update.
 */
const require = createRequire(import.meta.url);
const RUNNING = { build: '2.0.0-beta.61+0123456789ab', protocol: ENGINE_PROTOCOL };

describe('what an update changes', () => {
    it('a host’s hash is the part of its build after the version', () => {
        expect(hostHashOf('2.0.0-beta.61+0123456789ab')).toBe('0123456789ab');
        expect(hostHashOf('2.0.0-beta.61')).toBeNull();
        expect(hostHashOf('dev')).toBeNull();
    });

    it('the same host by hash and protocol is client-only, whatever the version', () => {
        expect(classifyUpdate({ hostHash: '0123456789ab', engineProtocol: ENGINE_PROTOCOL }, RUNNING)).toEqual({ kind: 'client-only' });
    });

    it.each([
        ['another host', { hostHash: 'ffffffffffff', engineProtocol: ENGINE_PROTOCOL }, /host/],
        ['another protocol', { hostHash: '0123456789ab', engineProtocol: ENGINE_PROTOCOL + 1 }, /protocol/],
        ['a feed that says nothing', {}, /does not say/],
        ['a hash that is not one', { hostHash: 'nope', engineProtocol: ENGINE_PROTOCOL }, /does not say/],
    ])('%s is a full update, and says why', (_name, offered, why) => {
        const scope = classifyUpdate(offered, RUNNING);
        expect(scope.kind).toBe('full');
        expect(scope.kind === 'full' ? scope.why : '').toMatch(why);
    });

    it('a running host with no hash (a dev build) is a full update', () => {
        expect(classifyUpdate({ hostHash: '0123456789ab', engineProtocol: ENGINE_PROTOCOL }, { build: 'dev', protocol: ENGINE_PROTOCOL }).kind).toBe('full');
    });
});

describe('the new window adopts the same host', () => {
    const record = { pid: 7, endpoint: 'pipe', protocol: ENGINE_PROTOCOL, build: '2.0.0-beta.60+0123456789ab', startedAt: 1 };
    it('another version, the same host hash and protocol: adopted', () => {
        expect(hostDecision(record, () => true, { protocol: ENGINE_PROTOCOL, build: '2.0.0-beta.61+0123456789ab' }).kind).toBe('adopt');
    });
    it('CONTROL: another host hash is replaced, and so is a build with no hash that differs', () => {
        expect(hostDecision(record, () => true, { protocol: ENGINE_PROTOCOL, build: '2.0.0-beta.61+ffffffffffff' }).kind).toBe('replace');
        expect(hostDecision({ ...record, build: 'dev' }, () => true, { protocol: ENGINE_PROTOCOL, build: 'dev2' }).kind).toBe('replace');
    });
});

const events: string[] = [];
const lib = (offer: { version: string; hostHash?: string | null; engineProtocol?: number | null }): UpdaterPort => ({
    configure: () => {},
    check: async () => offer,
    download: async (progress) => { progress(100); },
    quitAndInstall: () => { events.push('quitAndInstall'); },
});
const hostOptions = (port: UpdaterPort) => ({
    port, installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, defer: (fn: () => void) => { fn(); },
    running: RUNNING,
    agents: { live: () => [{ id: 'a1', name: 'Ada' }], stopAll: async () => { events.push('drain agents'); } },
    stopHosted: async () => { events.push('stop hosted'); },
});

describe('the install', () => {
    beforeEach(() => { events.length = 0; });

    it('client-only: the offer says so, and the install stops no agent and nothing hosted', async () => {
        const host = new UpdateHost(hostOptions(lib({ version: '2.0.0-beta.62', hostHash: '0123456789ab', engineProtocol: ENGINE_PROTOCOL })));
        expect((await host.check()).scope).toEqual({ kind: 'client-only' });
        await host.download();
        expect(host.state().scope).toEqual({ kind: 'client-only' });
        await host.install();
        expect(events).toEqual(['quitAndInstall']);
    });

    it('CONTROL, full: the agents are drained and what is hosted is stopped first', async () => {
        const host = new UpdateHost(hostOptions(lib({ version: '2.0.0-beta.62', hostHash: 'ffffffffffff', engineProtocol: ENGINE_PROTOCOL })));
        await host.check();
        await host.download();
        await host.install();
        expect(events).toEqual(['drain agents', 'stop hosted', 'quitAndInstall']);
    });
});

describe('genie-host at a client-only install', () => {
    const run = async (hostHash: string) => {
        const sent: UpdaterEvent[] = [];
        let exited = 0;
        const service = new UpdatesService({
            host: { installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, running: RUNNING, agents: { live: () => [], stopAll: async () => {} }, stopHosted: async () => {} },
            startHelper: () => {}, defaultLaunch: { file: 'genie', args: ['--updater'] }, windowConnected: () => true,
            exit: () => { exited += 1; }, defer: (fn) => { fn(); },
        });
        service.helperLinked('helper', 99, (event) => {
            sent.push(event);
            if (event.kind !== 'request') return;
            const value = event.op === 'check' ? { version: '2.0.0-beta.62', hostHash, engineProtocol: ENGINE_PROTOCOL } : null;
            queueMicrotask(() => { service.helperCall('reply', [event.id, true, value], 'helper'); });
        });
        await service.call('check', [], { window: true });
        await service.call('download', [], { window: true });
        await service.call('install', [42], { window: true });
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
        const install = sent.find((e): e is Extract<UpdaterEvent, { kind: 'request' }> => e.kind === 'request' && e.op === 'install');
        return { wait: install?.wait ?? null, exited };
    };

    it('it hands over the install, waits for the window alone, and stays', async () => {
        const { wait, exited } = await run('0123456789ab');
        expect(wait?.pids).toEqual([42]);
        expect(exited).toBe(0);
    });

    it('CONTROL, a full update: the helper waits for the host too, and the host exits', async () => {
        const { wait, exited } = await run('ffffffffffff');
        expect(wait?.pids).toEqual([10, 42]);
        expect(exited).toBe(1);
    });
});

describe('the updater is an ADF host-service on both sides', () => {
    it('with its reach.link: engine.updates, and updates.event', () => {
        const element = genieCatalog().list().find((e) => e.id === 'genie.updater');
        expect(element?.kind).toBe('host-service');
        expect(element?.reach).toMatchObject({ side: 'both', link: { calls: ['engine.updates'], events: ['updates.event'] } });
    });
});

describe('the release feed says which host it carries', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie-feed-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('adds genieHostHash (the host bundle’s hash, as its build says it) and genieEngineProtocol, and nothing else changes', () => {
        const hostJs = join(dir, 'host.js');
        writeFileSync(hostJs, 'the host');
        const yml = 'version: 2.0.0-beta.62\npath: Genie-2.0.0-beta.62-setup.exe\nsha512: abc\n';
        const out = feedHostIdentity(yml, { hostScript: hostJs, protocol: ENGINE_PROTOCOL }) as string;
        const parsed = require('js-yaml').load(out) as Record<string, unknown>;
        expect(parsed.genieHostHash).toBe(createHash('sha256').update('the host').digest('hex').slice(0, 12));
        expect(parsed.genieEngineProtocol).toBe(ENGINE_PROTOCOL);
        expect(out.startsWith(yml)).toBe(true);
    });

    it('both release jobs write it before their feed is uploaded', () => {
        const wf = readFileSync('.github/workflows/release.yml', 'utf8');
        expect(wf).toMatch(/node scripts\/feed-host-identity\.mjs release\/latest\.yml[\s\S]*gh release upload[^\n]*release\/latest\.yml/);
        expect(wf).toMatch(/node scripts\/feed-host-identity\.mjs release\/latest-linux\.yml[\s\S]*gh release upload[^\n]*release\/latest-linux\.yml/);
    });

    it('the updater passes what the feed says on to the host', () => {
        expect(readFileSync('src/main/electron-updater-port.ts', 'utf8')).toMatch(/hostHash: [^\n]*genieHostHash/);
    });
});

describe('the host copy is keyed by the host, not the version', () => {
    it('main names the copy by the host hash, so a client-only update copies nothing and removes nothing under the host', () => {
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/hostHash: hostHashOf\(hostBuildNow\) \?\?/);
        void mkdirSync;
    });
});
