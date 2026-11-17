import { describe, expect, it } from 'vitest';
import { cloneOffers } from '../src/core/clone-offers.js';

/**
 * WHAT THE REPO NOW SAYS THAT THIS MACHINE DOES NOT (Tynn #756, PR9c). A teammate pushes a flow, a process or a tab layout: the files
 * under `.flows/`, `.processes/` and `.genie/tabs.json` differ from what Genie would save from this workspace now. Each difference is
 * an OFFER, with what the repo says (incoming) beside what this machine has (local). A file the repo no longer has is only told;
 * nothing is ever offered for removal. Fixtures are invented names.
 */

const f = (path: string, value: unknown) => ({ path, value });
const doc = (command: string) => ({ $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 's', kind: 'genie/terminal_run', config: { workspace: '${workspace}', command } }], edges: [] } });

describe('the offers', () => {
    it('a file the repo has and this machine has nothing for is a NEW offer, with nothing local', () => {
        const { offers, removed } = cloneOffers([f('.flows/nightly-backup.json', doc('npm run backup'))], []);
        expect(offers).toEqual([{ id: 'flow:.flows/nightly-backup.json', kind: 'flow', file: '.flows/nightly-backup.json', change: 'new', summary: 'New flow: nightly-backup', incoming: doc('npm run backup'), local: null }]);
        expect(removed).toEqual([]);
    });

    it('a file that differs from what this machine would save is a CHANGED offer: the repo’s beside this machine’s', () => {
        const { offers } = cloneOffers([f('.flows/nightly-backup.json', doc('npm run backup:all'))], [f('.flows/nightly-backup.json', doc('npm run backup'))]);
        expect(offers).toEqual([{ id: 'flow:.flows/nightly-backup.json', kind: 'flow', file: '.flows/nightly-backup.json', change: 'changed', summary: 'Changed flow: nightly-backup', incoming: doc('npm run backup:all'), local: doc('npm run backup') }]);
    });

    it('CONTROL: the same content, in a different key order, is no offer', () => {
        const a = { command: 'x', folder: 'repos/app', restart: 'always' };
        const b = { restart: 'always', folder: 'repos/app', command: 'x' };
        expect(cloneOffers([f('.processes/w.json', a)], [f('.processes/w.json', b)])).toEqual({ offers: [], removed: [] });
    });

    it('processes and the tabs are offered the same way, in words', () => {
        const { offers } = cloneOffers([f('.processes/queue-worker.json', { command: 'a' }), f('.genie/tabs.json', { tabs: [] })], [f('.processes/queue-worker.json', { command: 'b' })]);
        expect(offers.map((o) => [o.id, o.change, o.summary])).toEqual([
            ['process:.processes/queue-worker.json', 'changed', 'Changed process: queue-worker'],
            ['tabs:.genie/tabs.json', 'new', 'New workspace tabs'],
        ]);
    });

    it('what this machine would save and the repo no longer has is told, never offered', () => {
        const { offers, removed } = cloneOffers([], [f('.flows/gone.json', doc('x')), f('.genie/tabs.json', { tabs: [] })]);
        expect(offers).toEqual([]);
        expect(removed).toEqual(['.flows/gone.json', '.genie/tabs.json']);
    });

    it('a file that is not one of the three places, and a file that could not be read, is not an offer', () => {
        expect(cloneOffers([f('project.json', { a: 1 }), f('.flows/readme.md', 'x'), f('.flows/broken.json', undefined), f('.flows/ok.json', doc('x'))], []).offers.map((o) => o.file)).toEqual(['.flows/ok.json']);
    });

    it('the order is the repo’s, flows then processes then tabs, and each id is its own', () => {
        const { offers } = cloneOffers([f('.genie/tabs.json', { tabs: [] }), f('.processes/p.json', { command: 'x' }), f('.flows/b.json', doc('b')), f('.flows/a.json', doc('a'))], []);
        expect(offers.map((o) => o.id)).toEqual(['flow:.flows/a.json', 'flow:.flows/b.json', 'process:.processes/p.json', 'tabs:.genie/tabs.json']);
    });
});
