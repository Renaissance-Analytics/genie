import { describe, expect, it } from 'vitest';
import { addressOf, routeOfAddress, slugsFor, type AddressContext } from '../src/core/address.js';

/**
 * GENIE ADDRESSES ARE genie://{workstation}/{workspace-slug}/{tab} (the owner, 2026-10-19: "this whole address is wrong.
 * it should be genie://{workstation}/{workspace-slug}/{tab}"; the grammar approved in q_6ac7e66d, "build this grammar").
 *
 *  - workspace tabs: genie://alphar/tynn-ai/dashboard (the default — genie://alphar/tynn-ai lands there), …/settings,
 *    …/github, …/terminals, a designed tab by its slug;
 *  - an agent's tab: genie://alphar/tynn-ai/atlas, its own sub-tab after it (…/atlas/changes);
 *  - genie's own agent: genie://alphar/genie;
 *  - pages that are not a workspace: genie://alphar/dashboard, …/deck, …/hosting, …/settings/{section} — reserved words,
 *    so a workspace named "settings" gets the slug settings-2;
 *  - the file panel stays a query: …/tynn-ai/dashboard?files=src/core/route.ts&line=42;
 *  - no chat= anywhere, no ULIDs; old addresses keep working and are rewritten.
 *
 * The app keeps its internal routes (ids, core/route.ts); this module is the translation at the edge — the hash and the
 * title bar.
 */
const ctx: AddressContext = {
    workstation: 'alphar',
    workspaces: [
        { id: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'Tynn.ai', path: '/w/tynn.ai' },
        { id: 'ws_settings', name: 'Settings', path: '/w/settings' },
        { id: 'ws_noname', path: '/w/Fancy UI' },
    ],
    agents: [
        { id: 'agent_atlas', name: 'atlas', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk' },
        { id: 'agent_dash', name: 'dashboard', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk' },
        { id: 'agent_genie', name: 'genie', workspaceId: '__genie__' },
    ],
    tabsOf: (id) => (id === '01k95ewyzkvkbxtpdt8b3qvyqk' ? [{ id: 'tab-a1', name: 'Ops board' }] : []),
};
const TYNN = '01k95ewyzkvkbxtpdt8b3qvyqk';

describe('slugsFor — a workspace by its project name, unique, never a reserved word', () => {
    it('Tynn.ai → tynn-ai; a reserved name gets -2; no name: the folder', () => {
        expect(slugsFor(ctx.workspaces)).toEqual(new Map([[TYNN, 'tynn-ai'], ['ws_settings', 'settings-2'], ['ws_noname', 'fancy-ui']]));
    });

    it('two workspaces with one name: the second gets -2', () => {
        const two = slugsFor([{ id: 'a', name: 'Fancy', path: '/a' }, { id: 'b', name: 'Fancy', path: '/b' }]);
        expect([...two.values()]).toEqual(['fancy', 'fancy-2']);
    });
});

describe('addressOf — an internal route as the address', () => {
    it('workspace tabs: dashboard is the default; settings, github, terminals; a designed tab by its slug', () => {
        expect(addressOf(`genie://workspace/${TYNN}`, ctx)).toBe('genie://alphar/tynn-ai/dashboard');
        expect(addressOf(`genie://workspace/${TYNN}?view=settings`, ctx)).toBe('genie://alphar/tynn-ai/settings');
        expect(addressOf(`genie://workspace/${TYNN}?view=github`, ctx)).toBe('genie://alphar/tynn-ai/github');
        expect(addressOf(`genie://workspace/${TYNN}?view=terminals`, ctx)).toBe('genie://alphar/tynn-ai/terminals');
        expect(addressOf(`genie://workspace/${TYNN}?view=tab:tab-a1`, ctx)).toBe('genie://alphar/tynn-ai/ops-board');
    });

    it('the file panel stays a query', () => {
        expect(addressOf(`genie://workspace/${TYNN}?files=src%2Fcore%2Froute.ts&line=42`, ctx)).toBe('genie://alphar/tynn-ai/dashboard?files=src%2Fcore%2Froute.ts&line=42');
        expect(addressOf(`genie://workspace/${TYNN}?files=`, ctx)).toBe('genie://alphar/tynn-ai/dashboard?files=');
    });

    it("an agent's tab by its name, its sub-tab after it; stream is the default", () => {
        expect(addressOf('genie://agent/agent_atlas?tab=stream', ctx)).toBe('genie://alphar/tynn-ai/atlas');
        expect(addressOf('genie://agent/agent_atlas?tab=changes', ctx)).toBe('genie://alphar/tynn-ai/atlas/changes');
        expect(addressOf('genie://agent/agent_atlas?tab=stream&lane=tools&at=ev_1', ctx)).toBe('genie://alphar/tynn-ai/atlas?lane=tools&at=ev_1');
    });

    it('an agent whose name is a tab word is written @name, so the two never meet', () => {
        expect(addressOf('genie://agent/agent_dash?tab=stream', ctx)).toBe('genie://alphar/tynn-ai/@dashboard');
    });

    it("genie's own agent; pages that are not a workspace", () => {
        expect(addressOf('genie://agent/agent_genie?tab=stream', ctx)).toBe('genie://alphar/genie');
        expect(addressOf('genie://dashboard?group=workspace', ctx)).toBe('genie://alphar/dashboard');
        expect(addressOf('genie://dashboard?group=status', ctx)).toBe('genie://alphar/dashboard?group=status');
        expect(addressOf('genie://deck?item=q1', ctx)).toBe('genie://alphar/deck?item=q1');
        expect(addressOf('genie://hosting?tab=processes', ctx)).toBe('genie://alphar/hosting?tab=processes');
        expect(addressOf('genie://settings/providers', ctx)).toBe('genie://alphar/settings/providers');
    });

    it('NO chat= anywhere — and no ULID', () => {
        const a = addressOf(`genie://workspace/${TYNN}?chat=agent_atlas&pin=right`, ctx);
        expect(a).toBe('genie://alphar/tynn-ai/dashboard');
        expect(a).not.toMatch(/chat=|01k95/);
    });

    it('a route Genie cannot name yet (unknown workspace or agent) stays as it is — never a wrong address', () => {
        expect(addressOf('genie://workspace/ws_unknown', ctx)).toBe('genie://workspace/ws_unknown');
        expect(addressOf('genie://agent/agent_unknown?tab=stream', ctx)).toBe('genie://agent/agent_unknown?tab=stream');
    });
});

describe('routeOfAddress — the address back as the internal route', () => {
    it('round-trips every form above (COUNTED)', () => {
        const internals = [
            `genie://workspace/${TYNN}`,
            `genie://workspace/${TYNN}?view=settings`,
            `genie://workspace/${TYNN}?view=tab:tab-a1`,
            `genie://workspace/${TYNN}?files=src%2Fcore%2Froute.ts&line=42`,
            'genie://agent/agent_atlas?tab=changes',
            'genie://agent/agent_dash?tab=stream',
            'genie://agent/agent_genie?tab=stream',
            'genie://dashboard?group=status',
            'genie://deck?item=q1',
            'genie://settings/providers',
        ];
        for (const r of internals) {
            const back = routeOfAddress(addressOf(r, ctx), ctx);
            expect(back === null ? null : addressOf(back, ctx), r).toBe(addressOf(r, ctx));
        }
    });

    it('genie://alphar/tynn-ai lands on the dashboard; the workstation name ignores case', () => {
        expect(routeOfAddress('genie://alphar/tynn-ai', ctx)).toBe(`genie://workspace/${TYNN}`);
        expect(routeOfAddress('genie://Alphar/tynn-ai/dashboard', ctx)).toBe(`genie://workspace/${TYNN}`);
    });

    it('an OLD address is understood as it is (and the app rewrites it)', () => {
        expect(routeOfAddress(`genie://workspace/${TYNN}?chat=agent_atlas`, ctx)).toBe(`genie://workspace/${TYNN}?chat=agent_atlas`);
        expect(routeOfAddress('genie://dashboard', ctx)).toBe('genie://dashboard');
    });

    it("a designed tab before its workspace's tabs are read lands on that workspace; once read, on the tab", () => {
        const unread: AddressContext = { ...ctx, tabsOf: () => undefined };
        expect(routeOfAddress('genie://alphar/tynn-ai/ops-board', unread)).toBe(`genie://workspace/${TYNN}`);
        expect(routeOfAddress('genie://alphar/tynn-ai/ops-board', ctx)).toBe(`genie://workspace/${TYNN}?view=tab%3Atab-a1`);
        // CONTROL: tabs read and none matches, no agent either — it names nothing.
        expect(routeOfAddress('genie://alphar/tynn-ai/ops-bored', ctx)).toBeNull();
    });

    it('an address that names nothing here is null — never a guess', () => {
        expect(routeOfAddress('genie://alphar/no-such-workspace', ctx)).toBeNull();
        expect(routeOfAddress('genie://alphar/tynn-ai/no-such-agent', ctx)).toBeNull();
        expect(routeOfAddress('genie://other-machine/tynn-ai', ctx)).toBeNull();
    });
});
