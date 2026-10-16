import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupByWorkspace, workspaceFault, type AgentRow } from '../src/core/dashboard-view.js';
import { listReposOf, type RepoOpsPorts } from '../src/main/repo-ops-host.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE WORKSPACE-LEVEL FAULT on the Dashboard's group header (the board: `⚠ repo site not found in moic.agi
 * [Locate repo]`). A registered repo whose folder is not where the manifest says is a fault of the WORKSPACE, not of
 * any agent: the host flags the entry when it lists the registry, the view turns the first such entry into the
 * header's sentence, and the fix is a door to the workspace's registry. No fault when every repo is there — and none
 * when the registry has not been read: "not seen" is not "none".
 */
function fakes(files: Record<string, unknown>, existing: string[] = []) {
    const store: Record<string, unknown> = { ...files };
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: RepoOpsPorts = {
        fs: {
            exists: async (p) => existing.includes(key(p)) || key(p) in store,
            readJson: async (p) => store[key(p)] ?? null,
            writeJson: async () => {},
        },
        registry: { workspace: (id) => (id === 'moic' ? { id: 'moic', path: '/w/moic' } : null) },
    };
    return { ports };
}
const manifest = { name: 'moic', type: 'agi', repos: [{ name: 'moic', slug: 'moic', path: '.' }, { name: 'site', slug: 'site', path: 'repos/site' }, { name: 'api', slug: 'api', path: 'repos/api' }] };

describe('the host flags a registered repo whose folder is gone', () => {
    it('`missing: true` on that entry only; the host repo (`.`) is never missing; a present folder carries no flag', async () => {
        const f = fakes({ '/w/moic/project.json': manifest }, ['/w/moic/repos/api']);
        const r = await listReposOf(f.ports, 'moic');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.repos.map((x) => [x.slug, x.missing ?? null])).toEqual([['moic', null], ['site', true], ['api', null]]);
    });
});

describe('workspaceFault', () => {
    it('the first missing repo, in the board’s words; null when none is missing and when the registry was not read', () => {
        expect(workspaceFault([{ slug: 'moic' }, { slug: 'site', missing: true }, { slug: 'api', missing: true }], 'moic')).toEqual({ text: 'repo site not found in moic.agi', repo: 'site' });
        expect(workspaceFault([{ slug: 'moic' }, { slug: 'site', missing: false }], 'moic')).toBeNull();
        expect(workspaceFault(null, 'moic')).toBeNull();
    });

    it('rides the group', () => {
        const fault = { text: 'repo site not found in moic.agi', repo: 'site' };
        const [withFault] = groupByWorkspace([], ['moic'], {}, { moic: fault });
        expect(withFault?.fault).toEqual(fault);
        const [without] = groupByWorkspace([], ['moic'], {}, { moic: null });
        expect(without?.fault).toBeUndefined();
    });
});

describe('the group header', () => {
    const row = (over: Partial<AgentRow>): AgentRow =>
        ({ id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'moic', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [], target: null, delivery: null, collaborators: null, commsLevel: null, context: null, ...over }) as AgentRow;
    const workspaces = [{ id: 'moic', name: 'moic', path: '/w/moic' }];
    const render = (faults: Record<string, { text: string; repo: string } | null>) =>
        renderToStaticMarkup(<Dashboard rows={[row({})]} workspaces={workspaces} onOpenAgent={() => {}} onAddAgent={() => {}} faults={faults} onLocateRepo={() => {}} />);

    it('shows the sentence and its `Locate repo` door on the group with a fault', () => {
        const html = render({ moic: { text: 'repo site not found in moic.agi', repo: 'site' } });
        expect(html).toMatch(/data-workspace-fault="site"[\s\S]*?repo site not found in moic\.agi[\s\S]*?data-action="locate-repo"/);
    });

    it('nothing on a group without one (positive control: the same board, no fault)', () => {
        const html = render({ moic: null });
        expect(html).not.toContain('data-workspace-fault');
        expect(html).not.toContain('data-action="locate-repo"');
    });
});
