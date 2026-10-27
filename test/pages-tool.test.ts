import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { ApprovalQueue, PERSON_ONLY_ACTIONS } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * AGENTS DRIVE GENIE SITE PAGES (browser rebuild step 7, part 2; the owner, FTQ q_82269ca5). Fancy's human+ navigation
 * bridge (@particle-academy/agent-integrations 0.47.1) over each open page — a tab of the Genie browser window or a live
 * site panel — through a script Genie injects into an ISOLATED world, never the page's own.
 *
 * - The `pages` tool: the workspace's default agent, or one whose "May drive pages" switch is on (#1077) — hidden from
 *   everyone else, and refused in words by the handler too.
 * - Which pages: only those showing one of the caller's workspace's sites (counted against another workspace's page).
 * - A submit, and a click the page marks destructive, wait for the person — an autonomous agent included (person-only
 *   approvals) — unless the agent's own "May drive pages" switch is on (genie#1294, test/permission-switch-approvals).
 *   Declined: nothing reaches the page. Reading, filling and ordinary clicks do not ask.
 *
 * The page here is a fake TRANSPORT answering fancy's remote adapter (describe / setField / click / submit …), and the
 * tool runs fancy's real bridge over it — so what is checked is the whole path the agent's call takes.
 */
const pagesModule = () => import('../src/main/mcp-tools-pages.js') as Promise<Record<string, any>>;

const A = 'example';
const DEFAULT = { agentId: 'a_default', workspaceId: A, agentName: 'lead', workspacePath: '/w/example' } as unknown as Caller;
const OTHER = { agentId: 'a_other', workspaceId: A, agentName: 'helper', workspacePath: '/w/example' } as unknown as Caller;

function fakePage(id: string, url: string) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let revision = 1;
    const transport = {
        call: async (method: string, args: unknown[]) => {
            calls.push({ method, args });
            switch (method) {
                case 'getLocation': return { url, title: 'Projects' };
                case 'describe': return {
                    url, title: 'Projects',
                    actions: [
                        { handle: 'name', role: 'textbox', label: 'Name' },
                        { handle: 'save', role: 'button', label: 'Save' },
                        { handle: 'open', role: 'link', label: 'Open project' },
                        { handle: 'del', role: 'button', label: 'Delete project', destructive: true },
                    ],
                };
                case 'read': return { title: 'Projects', headings: [], text: 'Projects list' };
                case 'setField': case 'click': case 'submit': return { ok: true };
                default: return null;
            }
        },
    };
    return { page: { id, url, title: 'Projects', transport, revision: () => revision }, calls, bump: () => { revision++; } };
}

function harness(opts: { drivePages?: boolean; approve?: 'allowed' | 'denied' } = {}) {
    const mine = fakePage('panel:example:t1:0', 'https://shop.gen/projects');
    const theirs = fakePage('panel:other:t1:0', 'https://other.gen/');
    const asked: Array<{ caller: string; action: string; detail: string }> = [];
    const roster: AgentRecord[] = [
        { id: 'a_default', workspaceId: A, name: 'lead' } as AgentRecord,
        { id: 'a_other', workspaceId: A, name: 'helper', ...(opts.drivePages ? { drivePages: true } : {}) } as AgentRecord,
    ];
    const callers: Record<string, Caller> = { 'sess-default': DEFAULT, 'sess-other': OTHER };
    const deps = {
        resolveCaller: (key: string) => callers[key] ?? null,
        defaultAgentOf: (ws: string) => (ws === A ? 'a_default' : null),
        roster: () => roster,
        sites: (ws: string) => (ws === A ? ['shop.gen'] : ['other.gen']),
        pages: () => [mine.page, theirs.page],
        approve: async (caller: Caller, action: string, detail: string) => { asked.push({ caller: caller.agentId, action, detail }); return opts.approve ?? 'allowed'; },
    };
    return { deps, mine, theirs, asked };
}

async function tool(h: ReturnType<typeof harness>) {
    const { pagesTools } = await pagesModule();
    const [t] = pagesTools(h.deps);
    return t;
}
// As prism-mcp-server hands them over: the session in both headers it may arrive in.
const as = (session: string) => ({ headers: { 'mcp-param-genie-session': session, 'genie-session': session } });
const json = (r: { text: string }) => JSON.parse(r.text) as Record<string, any>;

describe('who has the tool', () => {
    it('the workspace’s default agent sees it; another agent does not, until its switch is on', async () => {
        expect((await tool(harness())).visible(as('sess-default'))).toBe(true);
        expect((await tool(harness())).visible(as('sess-other'))).toBe(false);
        expect((await tool(harness({ drivePages: true }))).visible(as('sess-other'))).toBe(true);
    });

    it('the handler checks again: an agent without the switch is refused in words, and no page is touched', async () => {
        const h = harness();
        const r = await (await tool(h)).handler({ action: 'list' }, as('sess-other'));
        expect(r.isError).toBe(true);
        expect(json(r).error).toMatch(/May drive pages/);
        expect(h.mine.calls).toEqual([]);
    });
});

describe('which pages', () => {
    it('list: only pages showing this workspace’s sites — another workspace’s open page is not there (counted)', async () => {
        const h = harness();
        const r = json(await (await tool(h)).handler({ action: 'list' }, as('sess-default')));
        expect(r.pages.map((p: { id: string }) => p.id)).toEqual(['panel:example:t1:0']);
    });

    it('acting on another workspace’s page, or one that is not open, is refused in words — the page is not touched', async () => {
        const h = harness();
        const t = await tool(h);
        for (const page of ['panel:other:t1:0', 'panel:gone:t9:9']) {
            const r = await t.handler({ action: 'call', page, tool: 'page_describe' }, as('sess-default'));
            expect(r.isError).toBe(true);
        }
        expect(h.theirs.calls).toEqual([]);
    });
});

describe('driving a page', () => {
    const run = async (h: ReturnType<typeof harness>, steps: Array<[string, Record<string, unknown>?]>) => {
        const t = await tool(h);
        const out = [];
        for (const [name, args] of steps) out.push(await t.handler({ action: 'call', page: 'panel:example:t1:0', tool: name, args: args ?? {} }, as('sess-default')));
        return out;
    };

    it('describe, read and fill go straight through — nobody is asked', async () => {
        const h = harness();
        const [d, r, f] = await run(h, [['page_describe'], ['page_read'], ['page_set_field', { handle: 'name', value: 'Acme' }]]);
        expect(d.text).toContain('[del]');
        expect(r.text).toContain('Projects list');
        expect(f.isError).toBe(false);
        expect(h.mine.calls.find((c) => c.method === 'setField')?.args).toEqual(['name', 'Acme']);
        expect(h.asked).toEqual([]);
    });

    it('a SUBMIT waits for the person, as page.submit naming the page; declined → nothing is submitted', async () => {
        const h = harness({ approve: 'denied' });
        const [, s] = await run(h, [['page_describe'], ['page_submit', { handle: 'save' }]]);
        expect(s.text).toMatch(/Declined/);
        expect(h.asked).toEqual([{ caller: 'a_default', action: 'page.submit', detail: expect.stringContaining('https://shop.gen/projects') }]);
        expect(h.mine.calls.filter((c) => c.method === 'submit')).toEqual([]);
    });

    it('CONTROL: allowed, the submit reaches the page once', async () => {
        const h = harness({ approve: 'allowed' });
        await run(h, [['page_describe'], ['page_submit', { handle: 'save' }]]);
        expect(h.mine.calls.filter((c) => c.method === 'submit').map((c) => c.args)).toEqual([['save']]);
    });

    it('a DESTRUCTIVE click asks (page.click); an ordinary click does not (counted)', async () => {
        const h = harness({ approve: 'denied' });
        const [, del, open] = await run(h, [['page_describe'], ['page_click', { handle: 'del' }], ['page_click', { handle: 'open' }]]);
        expect(del.text).toMatch(/Declined/);
        expect(open.isError).toBe(false);
        expect(h.asked.map((a) => a.action)).toEqual(['page.click']);
        expect(h.mine.calls.filter((c) => c.method === 'click').map((c) => c.args)).toEqual([['open']]);
    });

    it('the page changed under it (the person navigated): the action is cancelled until it describes again', async () => {
        const h = harness();
        const t = await tool(h);
        await t.handler({ action: 'call', page: 'panel:example:t1:0', tool: 'page_describe' }, as('sess-default'));
        h.mine.bump();
        const r = await t.handler({ action: 'call', page: 'panel:example:t1:0', tool: 'page_set_field', args: { handle: 'name', value: 'x' } }, as('sess-default'));
        expect(r.text).toMatch(/page_describe/);
        expect(h.mine.calls.filter((c) => c.method === 'setField')).toEqual([]);
    });
});

describe('autonomy alone does not answer a submit — only the "May drive pages" switch does (genie#1294)', () => {
    it('page.submit and page.click are person-only', () => {
        expect(PERSON_ONLY_ACTIONS).toEqual(expect.arrayContaining(['page.submit', 'page.click']));
    });

    it('an AUTONOMOUS agent’s submit still waits in the Deck; its other actions go through (control)', async () => {
        const q = new ApprovalQueue({ now: () => 0, autoApproved: () => true } as never);
        const caller = DEFAULT;
        let settled: string | null = null;
        void q.gate(caller, 'page.submit', 'Save on https://shop.gen/projects').then((v) => { settled = v; });
        await new Promise((r) => setTimeout(r, 0));
        expect(settled).toBeNull();
        expect(q.deckItems()).toHaveLength(1);
        expect(await q.gate(caller, 'workspace.tabs', 'add a tab')).toBe('allowed');
    });
});

describe('the Electron half, from source: the script goes into an ISOLATED world on every load', () => {
    const code = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    for (const file of ['../src/main/genie-browser-electron.ts', '../src/main/site-panels-electron.ts']) {
        it(`${file.split('/').pop()}: attaches page navigation to each view it makes, and never runs script in the page’s own world`, () => {
            const src = code(file);
            expect(src).toMatch(/attachPageNavigation\(/);
            expect(src).not.toMatch(/\.executeJavaScript\(/);
        });
    }

    it('the attachment injects DOM_NAVIGATION_SCRIPT on dom-ready into world NAV_WORLD, and calls go through the same world', () => {
        const src = code('../src/main/page-navigation-electron.ts');
        expect(src).toMatch(/wc\.on\('dom-ready', \(\) => \{[\s\S]*?executeJavaScriptInIsolatedWorld\(NAV_WORLD, \[\{ code: DOM_NAVIGATION_SCRIPT \}\]\)/);
        expect(src).toMatch(/executeJavaScriptInIsolatedWorld\(NAV_WORLD, \[\{ code: domNavigationCallScript\(/);
        expect(src).not.toMatch(/\.executeJavaScript\(/);
    });
});
