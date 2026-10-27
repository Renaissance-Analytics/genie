import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressOf, isInternalRoute, routeOfAddress, type AddressContext } from '../src/core/address.js';
import { DEFAULT_ROUTE, parseRoute, type Route } from '../src/core/route.js';
import { windowLabelOf } from '../src/core/window-activation.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * OPENING A FLOW OPENS THE CANVAS, NOT A SECOND MAIN WINDOW (genie#1302; beta.49, the owner: Open on a flow showed the
 * whole app again).
 *
 * Main opens the flow editor window on `index.html#genie://flow/<id>` (feature-ipc's `flows.openEditor` / `flows.newFlow`
 * → main's `openFlowEditorWindow`). The renderer reads its hash the way App.tsx does: before the snapshot, an INTERNAL
 * route is used as it is and anything else waits on the Dashboard; after it, `routeOfAddress` reads it, and `null`
 * means the Dashboard. `flow` was missing from the internal heads, so the window's own route read as "not a route"
 * both times and the window rendered the main shell. And once the snapshot arrived, `addressOf` would have rewritten the
 * hash to `genie://<workstation>/flow`, which names no page at all.
 *
 * Every other window main opens on a hash (take-over, files) is checked through the same steps, so this never fixes the
 * flow window by breaking one of them.
 */

const ctx: AddressContext = {
    workstation: 'alphar',
    workspaces: [{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn.ai' }],
    agents: [{ id: 'agent_atlas', name: 'atlas', workspaceId: 'tynn' }],
    tabsOf: () => [],
};

/** The route App.tsx renders for a window's hash: exactly its expression (DesktopApp's `route`). */
function windowRoute(hash: string, context: AddressContext | null): Route {
    const route = context ? routeOfAddress(hash, context) ?? DEFAULT_ROUTE : isInternalRoute(hash) ? hash : DEFAULT_ROUTE;
    return parseRoute(route);
}

/** What App.tsx writes back into the hash once the snapshot names the place (its address-rewrite effect). */
function rewrittenHash(hash: string, context: AddressContext): string {
    const route = routeOfAddress(hash, context) ?? DEFAULT_ROUTE;
    const shown = addressOf(route, context);
    return shown === hash || !isInternalRoute(hash) ? hash : shown;
}

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};
const roster = [{ id: 'agent_atlas', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
let dir: string;
let services: ComposedServices;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-flow-window-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, workspaces: () => [{ id: 'tynn', path: dir }] });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

/** The routes main hands the flow editor window, from the Flows page's own actions. */
async function routesMainOpens(): Promise<string[]> {
    const opened: string[] = [];
    const ports = { openFlowEditor: (route: string) => { opened.push(route); } };
    await handleFeatureAction(services, { kind: 'flows.openEditor', flowId: 'flow_7f3c' }, undefined, ports);
    await handleFeatureAction(services, { kind: 'flows.newFlow', workspaceId: 'tynn' }, undefined, ports);
    return opened;
}

describe('the flow editor window renders the editor, from the route main opens it on', () => {
    it('Open and Add a flow open the window on genie://flow/… (main’s side)', async () => {
        expect(await routesMainOpens()).toEqual(['genie://flow/flow_7f3c', 'genie://flow/new?workspace=tynn']);
    });

    it('before the snapshot: the window’s hash is the FLOW surface, not the Dashboard', async () => {
        const [open, add] = await routesMainOpens();
        expect(windowRoute(open!, null)).toMatchObject({ surface: 'flow', flowId: 'flow_7f3c', workspaceId: null });
        expect(windowRoute(add!, null)).toMatchObject({ surface: 'flow', flowId: null, workspaceId: 'tynn' });
    });

    it('after the snapshot: still the FLOW surface — routeOfAddress reads a flow route as it is', async () => {
        const [open, add] = await routesMainOpens();
        expect(windowRoute(open!, ctx)).toMatchObject({ surface: 'flow', flowId: 'flow_7f3c' });
        expect(windowRoute(add!, ctx)).toMatchObject({ surface: 'flow', flowId: null, workspaceId: 'tynn' });
    });

    it('the hash is never rewritten to an address the window cannot read back (genie://alphar/flow names nothing)', async () => {
        for (const route of await routesMainOpens()) {
            expect(addressOf(route, ctx)).toBe(route);
            expect(rewrittenHash(route, ctx)).toBe(route);
            expect(windowRoute(rewrittenHash(route, ctx), ctx).surface).toBe('flow');
        }
    });

    it('a new flow’s window, after its first save, moves to the flow’s own route and stays the editor', () => {
        const saved = `genie://flow/${encodeURIComponent('flow_9a1b')}`;
        expect(windowRoute(saved, null)).toMatchObject({ surface: 'flow', flowId: 'flow_9a1b' });
        expect(windowRoute(saved, ctx)).toMatchObject({ surface: 'flow', flowId: 'flow_9a1b' });
    });

    it('the activation ledger names the window `flow` — the label main’s open request carries — not `main`', () => {
        expect(windowLabelOf('file:///app/dist/renderer/index.html#genie://flow/flow_7f3c')).toBe('flow');
        expect(windowLabelOf('file:///app/dist/renderer/index.html#genie://flow/new?workspace=tynn')).toBe('flow');
        expect(windowLabelOf('file:///app/dist/renderer/index.html#genie://dashboard?group=workspace')).toBe('main');
    });
});

describe('the other guarded windows still render their own surface through the same steps', () => {
    it('take-over: genie://takeover/<terminal>, before and after the snapshot, and after its address rewrite', () => {
        const route = 'genie://takeover/term_42';
        expect(windowRoute(route, null)).toMatchObject({ surface: 'takeover', terminalId: 'term_42' });
        expect(windowRoute(route, ctx)).toMatchObject({ surface: 'takeover', terminalId: 'term_42' });
        expect(windowRoute(rewrittenHash(route, ctx), ctx)).toMatchObject({ surface: 'takeover', terminalId: 'term_42' });
        expect(windowLabelOf(`file:///app/index.html#${route}`)).toBe('takeover');
    });

    it('files: genie://files/<workspace>, before and after the snapshot, and after its address rewrite', () => {
        const route = 'genie://files/tynn';
        expect(windowRoute(route, null)).toMatchObject({ surface: 'files', workspaceId: 'tynn' });
        expect(windowRoute(route, ctx)).toMatchObject({ surface: 'files', workspaceId: 'tynn' });
        expect(windowRoute(rewrittenHash(route, ctx), ctx)).toMatchObject({ surface: 'files', workspaceId: 'tynn' });
        expect(windowLabelOf(`file:///app/index.html#${route}`)).toBe('files');
    });

    it('the Genie browser keeps its own page (browser.html), and the main window its Dashboard', () => {
        expect(windowLabelOf('file:///app/browser.html')).toBe('browser');
        expect(windowRoute(DEFAULT_ROUTE, null).surface).toBe('dashboard');
        expect(windowRoute(DEFAULT_ROUTE, ctx).surface).toBe('dashboard');
    });
});

describe('the wiring these steps stand for', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

    it('App.tsx resolves its hash with exactly the expression windowRoute() mirrors, and renders FlowEditorWindow for `flow`', () => {
        expect(app).toMatch(/const route = addressContext\s*\?\s*routeOfAddress\(address, addressContext\) \?\? DEFAULT_ROUTE\s*:\s*isInternalRoute\(address\) \? address : DEFAULT_ROUTE;/);
        expect(app).toMatch(/if \(parsed\.surface === 'flow'\) \{\s*return \(\s*<FlowEditorWindow/);
    });

    it('main loads the flow editor window on the renderer’s index.html with the route as its hash', () => {
        const fn = main.slice(main.indexOf('function openFlowEditorWindow('), main.indexOf('function closeWindowAt('));
        expect(fn).toMatch(/win\.loadFile\(join\(here, '\.\.\/renderer\/index\.html'\), \{ hash: route \}\)/);
    });
});
