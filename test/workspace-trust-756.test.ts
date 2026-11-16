import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustHash, trustVerdict, type TrustList } from '../src/core/workspace-trust.js';
import { readTrustList, WorkspaceTrust, type TrustListPorts } from '../src/main/workspace-trust-host.js';

/**
 * THE TRUST STEP, WITH WHAT A CLONE BRINGS (Tynn #756, PR9b). A workspace whose `.flows/` or `.processes/` hold something that would
 * run is not trusted until the person says yes, and the step shows those files' commands beside the sites and hooks. The yes stays
 * (Tynn #618: once, and durable); after it, what waited is restored: flows created DISARMED, processes kept STOPPED. Fixtures are
 * invented names.
 */

const NONE: TrustList = { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] };
const W = join('/ws', 'acme');
const at = (...parts: string[]) => join(W, ...parts);
const nobody = { carried: [] as string[], workspaces: {} as Record<string, string> };

describe('what makes a workspace one that would run something', () => {
    it('a flow that runs a command: untrusted until the person says yes, trusted for good after', () => {
        const list: TrustList = { ...NONE, flows: [{ file: '.flows/nightly.json', commands: ['npm run backup'] }] };
        expect(trustVerdict(nobody, 'w', trustHash(list)).trusted).toBe(false);
        expect(trustVerdict({ carried: [], workspaces: { w: 'then' } }, 'w', trustHash(list)).trusted).toBe(true);
    });

    it('a process: the same', () => {
        const list: TrustList = { ...NONE, processes: [{ file: '.processes/worker.json', commands: ['php artisan queue:work'] }] };
        expect(trustVerdict(nobody, 'w', trustHash(list)).trusted).toBe(false);
        expect(trustVerdict({ carried: [], workspaces: { w: 'then' } }, 'w', trustHash(list)).trusted).toBe(true);
    });

    it('the order the files were found in does not change the verdict, and they are not nothing', () => {
        const a = { file: '.flows/a.json', commands: ['one'] };
        const b = { file: '.flows/b.json', commands: ['two'] };
        expect(trustHash({ ...NONE, flows: [a, b] })).toBe(trustHash({ ...NONE, flows: [b, a] }));
        expect(trustHash({ ...NONE, flows: [a, b] })).not.toBe(trustHash(NONE));
    });

    it('CONTROL: empty lists are nothing to run, as an absent list is', () => {
        expect(trustHash({ ...NONE, flows: [], processes: [] })).toBe(trustHash(NONE));
        expect(trustVerdict(nobody, 'w', trustHash({ ...NONE, flows: [], processes: [] })).trusted).toBe(true);
    });
});

function listPorts(files: Record<string, string>): TrustListPorts {
    return {
        readText: async (p) => files[p] ?? null,
        gitConfig: async () => [],
        listDir: async (dir) => {
            const sep = join('a', 'b')[1]!;
            const names = Object.keys(files).filter((f) => f.startsWith(`${dir}${sep}`)).map((f) => f.slice(dir.length + 1));
            if (names.length === 0) throw new Error('ENOENT');
            return names;
        },
    };
}

describe('the list the step shows', () => {
    const flow = (command: string) => JSON.stringify({ $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }, { id: 's', kind: 'genie/terminal_run', position: { x: 1, y: 0 }, config: { workspace: '${workspace}', command } }], edges: [] } });
    const quiet = JSON.stringify({ $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 'l', kind: 'log', position: { x: 0, y: 0 }, config: { message: 'tick' } }], edges: [] } });

    it('names each flow and process file with what it would run; a flow that only logs, a file that is not JSON and one that is not .json are not on it', async () => {
        const list = await readTrustList(W, listPorts({
            [at('.flows', 'nightly.json')]: flow('npm run backup'),
            [at('.flows', 'quiet.json')]: quiet,
            [at('.flows', 'broken.json')]: '{ nope',
            [at('.flows', 'readme.md')]: '# not a flow',
            [at('.processes', 'worker.json')]: JSON.stringify({ command: 'php artisan queue:work', restart: 'always' }),
        }));
        expect(list.flows).toEqual([{ file: '.flows/nightly.json', commands: ['npm run backup'] }]);
        expect(list.processes).toEqual([{ file: '.processes/worker.json', commands: ['php artisan queue:work'] }]);
    });

    it('CONTROL: a workspace with neither folder, or a host that cannot list one, has no flows or processes on its list', async () => {
        expect(await readTrustList(W, listPorts({}))).toEqual(NONE);
        expect(await readTrustList(W, { readText: async () => null, gitConfig: async () => [] })).toEqual(NONE);
    });
});

describe('the person’s yes', () => {
    function trust() {
        const record: Record<string, string> = {};
        const told: string[] = [];
        const trust = new WorkspaceTrust({
            workspaces: () => [{ id: 'w', path: W }],
            record: () => ({ carried: [], workspaces: record }),
            recordWorkspace: async (id, hash) => { record[id] = hash; },
            forgetWorkspace: async (id) => { delete record[id]; },
            approveSites: async () => {},
            readText: async () => null,
            gitConfig: async () => [],
        });
        return { trust, told };
    }

    it('is told to whoever listens, once, with the workspace; refreshing and taking it back are not a yes', async () => {
        const { trust: t, told } = trust();
        t.onTrusted((id) => told.push(id));
        await t.refresh('w');
        expect(told).toEqual([]);
        await t.trust('w');
        expect(told).toEqual(['w']);
        await t.untrust('w');
        expect(told).toEqual(['w']);
    });

    it('a listener that throws does not undo the yes or stop the next listener', async () => {
        const { trust: t, told } = trust();
        t.onTrusted(() => { throw new Error('the restore failed'); });
        t.onTrusted((id) => told.push(id));
        expect(await t.trust('w')).toMatchObject({ trusted: true });
        expect(told).toEqual(['w']);
    });
});
