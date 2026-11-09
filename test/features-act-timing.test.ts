import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * genie#1583: A SETTINGS CHANGE THROUGH features.act TOOK 12-24 s on the Windows test VM. An action is the action itself
 * (a settings write is a genie-host round trip) and then a whole features snapshot. The snapshot already names its slow
 * knowledge and engines parts; the action and the snapshot as a whole are named too, so the next Windows run says which
 * half waits: `features slow part=act:<kind> ms=…` and `features slow part=snapshot ms=…`.
 */
function fakePty(): PtyPort {
    let n = 0;
    return {
        open: () => ({ id: `term_${++n}`, pid: 500 + n, shell: 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
}

let dir: string | null = null;
let services: ComposedServices | null = null;
afterEach(async () => {
    await services?.shutdown();
    services = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
});

describe('a slow features action names its slow half', () => {
    it('a slow settings write is named as the action, with its kind; the snapshot as a whole is named when it is slow', async () => {
        dir = await mkdtemp(join(tmpdir(), 'act-timing-'));
        services = await composeServices({ userData: dir, pty: fakePty(), v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        const real = services.settings;
        // A Proxy, not a copy: the store keeps private fields (#values), which a copied object does not have.
        const slowSet = async (...a: Parameters<typeof real.set>) => { await new Promise((r) => setTimeout(r, 60)); return real.set(...a); };
        const slowSettings = new Proxy(real, { get: (t, p) => (p === 'set' ? slowSet : ((v) => (typeof v === 'function' ? v.bind(t) : v))(Reflect.get(t, p, t))) });
        const slow = { ...services, settings: slowSettings } as ComposedServices;
        const said: string[] = [];
        await handleFeatureAction(slow, { kind: 'settings.set', key: 'track_cwd', value: true }, undefined, { slowPart: { ms: 40, log: (part, ms) => said.push(`${part} ${ms >= 40 ? 'over' : 'under'}`) } });
        expect(said).toContain('act:settings.set over');
    });

    it('CONTROL: under the bound, nothing is said of the action or the snapshot', async () => {
        dir = await mkdtemp(join(tmpdir(), 'act-timing-'));
        services = await composeServices({ userData: dir, pty: fakePty(), v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        const said: string[] = [];
        await handleFeatureAction(services, { kind: 'settings.set', key: 'track_cwd', value: true }, undefined, { slowPart: { ms: 5_000, log: (part) => said.push(part) } });
        expect(said).toEqual([]);
    });

    it('the snapshot as a whole is timed under its own name', async () => {
        dir = await mkdtemp(join(tmpdir(), 'act-timing-'));
        services = await composeServices({ userData: dir, pty: fakePty(), v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        const real = services.knowledge;
        const slow = { ...services, knowledge: Object.assign(Object.create(Object.getPrototypeOf(real)), real, { summaries: async (...a: Parameters<typeof real.summaries>) => { await new Promise((r) => setTimeout(r, 60)); return real.summaries(...a); } }) } as ComposedServices;
        const said: string[] = [];
        await handleFeatureAction(slow, { kind: 'whatsNew.show' }, undefined, { slowPart: { ms: 40, log: (part) => said.push(part) } });
        expect(said).toContain('knowledge');
        expect(said).toContain('snapshot');
        expect(said).not.toContain('act:whatsNew.show');
    });
});
