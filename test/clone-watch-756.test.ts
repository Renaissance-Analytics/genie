import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flowDocument } from '../src/core/flow-form.js';
import { flowsDeclaration } from '../src/core/workspace-flows.js';
import type { RepoFile } from '../src/core/clone-offers.js';
import { CloneWatch } from '../src/main/clone-watch-host.js';
import type { CloneRestorePorts } from '../src/main/workspace-clone-restore-host.js';

/**
 * THE WATCHER (Tynn #756, PR9c; the owner, 2026-11-16: it "notices upstream changes to these files and offers them, never
 * auto-applying"). A pass looks at `.flows/`, `.processes/` and `.genie/tabs.json`; only a change since the last pass is looked
 * into; what differs from what this machine has becomes an offer. NOTHING is created, written or armed by a pass. An offer is
 * applied only when the person asks, and only a NEW one: a changed one is told, never replaced. Fixtures are invented names.
 */

const WS = { id: 'ws_clone', path: '/c/acme' };
const flowFile = (name: string, command: string) => flowsDeclaration([{ name, workspaceId: 'w', document: flowDocument({ workspaceId: 'w', cron: '0 3 * * *', step: command === '' ? { kind: 'log' } : { kind: 'command', command, folder: '' } }) as unknown as Record<string, unknown> }], 'w').files[0]!.value;

function rig(over: { trusted?: boolean; asleep?: boolean } = {}) {
    const state = { asleep: over.asleep === true };
    const files: Record<string, string> = {};
    const made: { workspaceId: string; name: string }[] = [];
    /** What Genie would save for each flow it created, as the file said when it was created. */
    const applied: Record<string, unknown> = {};
    const writes: string[] = [];
    const scans = { live: 0 };
    const ports = {
        workspaces: () => [{ ...WS, ...(state.asleep ? { asleep: true } : {}) }],
        restore: {
            files: {
                read: async (p: string) => files[p] ?? null,
                list: async (dir: string) => { const n = Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)); if (n.length === 0) throw new Error('ENOENT'); return n; },
            },
            settings: {} as never,
            tabs: { values: () => ({ tabs: '', panelSplits: '', panelLayout: '' }), overridden: () => ({}), write: async (_w: string, key: string) => { writes.push(key); }, siteHosts: () => [] },
            flows: async () => ({ list: () => [], create: async (input: { workspaceId: string; name: string }) => { made.push(input); applied[input.name] = JSON.parse(files[`/c/acme/.flows/${input.name}.json`]!); return input; } }),
            processes: async () => ({ list: () => [], keep: async () => { writes.push('keep'); }, agentAddressOf: () => null }),
            trusted: () => over.trusted === true,
        } as unknown as CloneRestorePorts,
        stamp: async (p: string) => files[p] ?? null,
        live: async (): Promise<RepoFile[]> => {
            scans.live += 1;
            return made.map((m) => ({ path: `.flows/${m.name}.json`, value: applied[m.name] }));
        },
    };
    return { ports, files, made, writes, scans, state, watch: new CloneWatch(ports as never) };
}

describe('a pass', () => {
    it('offers what the repo has and this machine does not, and creates, writes and arms NOTHING', async () => {
        const r = rig({ trusted: true });
        r.files['/c/acme/.flows/quiet.json'] = JSON.stringify(flowFile('Quiet', ''));
        r.files['/c/acme/.processes/worker.json'] = JSON.stringify({ command: 'php artisan queue:work' });
        await r.watch.pass();
        expect(r.watch.list('ws_clone').map((o) => [o.id, o.change])).toEqual([['flow:.flows/quiet.json', 'new'], ['process:.processes/worker.json', 'new']]);
        expect(r.made).toEqual([]);
        expect(r.writes).toEqual([]);
    });

    it('looks into a workspace again only when one of its files changed, and says so to whoever listens only when the offers did', async () => {
        const r = rig();
        const heard: number[] = [];
        r.watch.onChange((_id, offers) => heard.push(offers.length));
        r.files['/c/acme/.flows/a.json'] = JSON.stringify(flowFile('A', ''));
        await r.watch.pass();
        await r.watch.pass();
        expect(r.scans.live).toBe(1);
        r.files['/c/acme/.flows/b.json'] = JSON.stringify(flowFile('B', ''));
        await r.watch.pass();
        expect(r.scans.live).toBe(2);
        expect(heard).toEqual([1, 2]);
    });

    it('a hibernated workspace is a ghost: not looked at, and looked at again once it is woken', async () => {
        const r = rig({ asleep: true });
        r.files['/c/acme/.flows/a.json'] = JSON.stringify(flowFile('A', ''));
        await r.watch.pass();
        expect(r.scans.live).toBe(0);
        expect(r.watch.list('ws_clone')).toEqual([]);
        r.state.asleep = false;
        await r.watch.pass();
        expect(r.scans.live).toBe(1);
        expect(r.watch.list('ws_clone').map((o) => o.id)).toEqual(['flow:.flows/a.json']);
    });

    it('CONTROL: a workspace with none of the three places has no offers and is not an error', async () => {
        const r = rig();
        await r.watch.pass();
        expect(r.watch.list('ws_clone')).toEqual([]);
    });
});

describe('applying an offer, which only the person does', () => {
    it('a new flow is created disarmed through the same restore as a clone’s, and the offer is gone after', async () => {
        const r = rig({ trusted: true });
        r.files['/c/acme/.flows/quiet.json'] = JSON.stringify(flowFile('Quiet', ''));
        await r.watch.pass();
        expect(await r.watch.apply('ws_clone', 'flow:.flows/quiet.json')).toEqual({ ok: true });
        expect(r.made).toEqual([expect.objectContaining({ workspaceId: 'ws_clone', name: 'quiet', by: { kind: 'user' } })]);
        expect(r.made[0]).not.toHaveProperty('armed');
        await r.watch.pass();
        expect(r.watch.list('ws_clone')).toEqual([]);
    });

    it('a new flow that runs a command waits for the workspace’s trust: refused, in words, and nothing is created', async () => {
        const r = rig({ trusted: false });
        r.files['/c/acme/.flows/nightly.json'] = JSON.stringify(flowFile('Nightly', 'npm run backup'));
        await r.watch.pass();
        const out = await r.watch.apply('ws_clone', 'flow:.flows/nightly.json');
        expect(out).toMatchObject({ ok: false });
        if (!out.ok) expect(out.reason).toMatch(/trust/);
        expect(r.made).toEqual([]);
    });

    it('a CHANGED one is never replaced: told, and nothing is touched', async () => {
        const r = rig({ trusted: true });
        r.files['/c/acme/.flows/quiet.json'] = JSON.stringify(flowFile('Quiet', ''));
        await r.watch.pass();
        await r.watch.apply('ws_clone', 'flow:.flows/quiet.json');
        r.files['/c/acme/.flows/quiet.json'] = JSON.stringify(flowFile('Quiet', 'npm run backup'));
        await r.watch.pass();
        const changed = r.watch.list('ws_clone');
        expect(changed.map((o) => [o.id, o.change])).toEqual([['flow:.flows/quiet.json', 'changed']]);
        const out = await r.watch.apply('ws_clone', 'flow:.flows/quiet.json');
        expect(out).toMatchObject({ ok: false });
        if (!out.ok) expect(out.reason).toMatch(/differs/);
        expect(r.made).toHaveLength(1);
    });

    it('an offer that is not there (it went away, or was never made) is refused in words', async () => {
        const r = rig();
        await r.watch.pass();
        expect(await r.watch.apply('ws_clone', 'flow:.flows/ghost.json')).toEqual({ ok: false, reason: 'that offer is gone: the repo no longer differs from this machine there' });
        expect(await r.watch.apply('nowhere', 'flow:.flows/ghost.json')).toMatchObject({ ok: false });
    });
});

describe('in genie-host', () => {
    it('watches the workspaces it owns on a clock, and logs what it is offered; it does not apply', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toContain('new CloneWatch(');
        expect(host).toMatch(/cloneWatch\.pass\(\)/);
        expect(host).not.toMatch(/cloneWatch\.apply\(/);
    });
});
