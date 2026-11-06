import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { describe, expect, it } from 'vitest';
import { HOST_NATIVE_TOOLS, hostRegistrations, windowClosedRefusal, type ForwardedToolCall } from '../src/main/mcp-host-tools.js';
import { NO_PAGES_HERE, notAvailableHere } from '../src/core/host-runtime.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { AgentId } from '../src/core/identity.js';

/**
 * GENIE'S MCP SERVER IN GENIE-HOST: WHICH TOOLS RUN THERE, AND WHAT THE REST DO WITH NO WINDOW (the host split, P3.1:
 * plan §11d).
 *
 * The tools whose world is the host's stores and sessions run in the host — an agent keeps them with the window closed.
 * Every other tool (sites, services, processes, terminals, pages, plugins…) still needs the window this phase, so the
 * host FORWARDS the call to it, with the caller the host resolved. With no window the agent is told so at once, in words
 * — never a hang — and a window that closes mid-call answers the same way. openFileForUser is kept for the next window.
 */

const def = (name: string) => new ToolDefinition(name, `${name} tool`, { type: 'object', properties: {} } as JsonObject, name);
const local = (name: string, ran: string[]): Registration => ({ definition: def(name), handler: async () => { ran.push(name); return { text: `${name} ran here`, isError: false }; } });
const CALLER: Caller = { agentId: 'agent_aaaa' as AgentId, agentName: 'atlas', workspaceId: 'ws', workspacePath: '/w' };
const ctx = (headers: Record<string, string> = { 'genie-session': 'session-1' }) => ({ server: 'genie', tool: 'x', headers });

function rig(window: { connected: boolean; answer?: (c: ForwardedToolCall) => Promise<McpToolResult> }) {
    const ran: string[] = [];
    const forwarded: ForwardedToolCall[] = [];
    const queuedOpens: unknown[] = [];
    const all = ['agentinbox', 'ForceTheQuestion', 'sites', 'services', 'openFileForUser', 'spreadsheet.createWorkbook'].map((n) => local(n, ran));
    const regs = hostRegistrations(all, {
        resolveCaller: (id) => (id === 'session-1' ? CALLER : null),
        window: {
            connected: () => window.connected,
            call: async (c) => { forwarded.push(c); if (!window.answer) throw new Error('The window closed before it answered.'); return window.answer(c); },
        },
        openFileLater: (c) => { queuedOpens.push(c); },
    });
    const byName = (n: string) => regs.find((r) => r.definition.name === n)!;
    return { regs, byName, ran, forwarded, queuedOpens };
}

describe('the host keeps its own tools; the rest are the window\'s', () => {
    it('the host-native list is the stores-and-sessions tools', () => {
        // processes joined in P3.3c (the book, its scheduler and the supervisor are the host's), flows in P3.3d, manageTerminals in P3.3e.
        expect([...HOST_NATIVE_TOOLS].sort()).toEqual(['ForceTheQuestion', 'agentinbox', 'flows', 'imDone', 'knowledge', 'lists', 'manageTerminals', 'plan', 'processes', 'thumbsUp'].sort());
    });

    it('a host-native tool runs in the host, window or not', async () => {
        const r = rig({ connected: false });
        expect(await r.byName('agentinbox').handler({}, ctx())).toEqual({ text: 'agentinbox ran here', isError: false });
        expect(r.forwarded).toEqual([]);
    });

    it('every tool keeps its definition (same name, schema, title): the agent\'s tool list does not change shape', () => {
        const r = rig({ connected: true });
        expect(r.regs.map((x) => x.definition.name)).toEqual(['agentinbox', 'ForceTheQuestion', 'sites', 'services', 'openFileForUser', 'spreadsheet.createWorkbook']);
    });
});

describe('a window tool', () => {
    it('with a window: forwarded with its arguments, headers and the caller the host resolved, and the window\'s answer is the answer', async () => {
        const r = rig({ connected: true, answer: async (c) => ({ text: `window ran ${c.name}`, isError: false }) });
        const result = await r.byName('sites').handler({ action: 'list' } as JsonObject, ctx());
        expect(result).toEqual({ text: 'window ran sites', isError: false });
        // With its id in the host while forwarded: an approval the window's tool asks is tied to this very call (genie#1360).
        expect(r.forwarded).toEqual([{ name: 'sites', args: { action: 'list' }, headers: { 'genie-session': 'session-1' }, caller: CALLER, callId: expect.stringMatching(/^fwd-/) }]);
        expect(r.ran).toEqual([]); // not run in the host
    });

    it('with NO window: refused AT ONCE, in words, as an error the agent reads — and nothing is forwarded', async () => {
        const r = rig({ connected: false });
        const result = await r.byName('services').handler({}, ctx());
        expect(result).toEqual({ text: windowClosedRefusal('services'), isError: true });
        expect(result.text).toMatch(/Genie's window, which is closed/);
        expect(r.forwarded).toEqual([]);
    });

    it('a window that closes mid-call answers in words too (never a hang), saying it may or may not have been done', async () => {
        const r = rig({ connected: true }); // connected, but its call rejects as the window goes
        const result = await r.byName('spreadsheet.createWorkbook').handler({}, ctx());
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/closed before it answered/);
        expect(result.text).toMatch(/check/);
    });
});

describe('openFileForUser with no window', () => {
    it('is KEPT for the next window, and the agent is told it opens then', async () => {
        const r = rig({ connected: false });
        const result = await r.byName('openFileForUser').handler({ path: 'src/a.ts', line: 3 } as JsonObject, ctx());
        expect(result.isError).toBe(false);
        expect(result.text).toMatch(/opens when Genie is next opened/);
        expect(r.queuedOpens).toEqual([{ name: 'openFileForUser', args: { path: 'src/a.ts', line: 3 }, headers: { 'genie-session': 'session-1' }, caller: CALLER }]);
    });

    it('with a window it is forwarded like any window tool (CONTROL for the queue above)', async () => {
        const r = rig({ connected: true, answer: async () => ({ text: 'opened', isError: false }) });
        expect(await r.byName('openFileForUser').handler({ path: 'src/a.ts' } as JsonObject, ctx())).toEqual({ text: 'opened', isError: false });
        expect(r.queuedOpens).toEqual([]);
    });
});

/**
 * WINDOW TOOLS ON A HOST THAT CAN HAVE NO WINDOW (P10.1d). genie-host on plain Node has no Electron: no Genie window to
 * forward a tool to, no Genie browser for `pages`. hostCapabilities() decides it, and every tool that needs one answers
 * "not available on this host" in the one wording — never "open Genie", which on such a host cannot help. Nothing is
 * forwarded, run or kept for later. The host's own tools are unchanged.
 */
describe('window tools on a host with no window and no browser', () => {
    // Every tool genie-host forwards to a window: the window's tools (sites, services, checkIssues, workspaceTabs,
    // createAgent, openFileForUser), pages, and a plugin's tool.
    const WINDOW_TOOLS = ['sites', 'services', 'checkIssues', 'workspaceTabs', 'createAgent', 'openFileForUser', 'ai.genie.spreadsheet.createWorkbook'];
    const rigHere = (connected: boolean, capabilities?: { window: boolean; browser: boolean }) => {
        const ran: string[] = [];
        const forwarded: ForwardedToolCall[] = [];
        const kept: unknown[] = [];
        const regs = hostRegistrations(['agentinbox', 'pages', ...WINDOW_TOOLS].map((n) => local(n, ran)), {
            resolveCaller: (id) => (id === 'session-1' ? CALLER : null),
            window: { connected: () => connected, call: async (c) => { forwarded.push(c); return { text: `window ran ${c.name}`, isError: false }; } },
            openFileLater: (c) => { kept.push(c); },
            ...(capabilities ? { capabilities } : {}),
        });
        return { byName: (n: string) => regs.find((r) => r.definition.name === n)!, ran, forwarded, kept };
    };
    const NONE = { window: false, browser: false };

    it.each([[false], [true]])('connected %s: pages says the Genie browser is not available here', async (connected) => {
        const r = rigHere(connected, NONE);
        expect(await r.byName('pages').handler({ action: 'list' } as JsonObject, ctx())).toEqual({ text: NO_PAGES_HERE, isError: true });
        expect(r.forwarded).toEqual([]);
        expect(r.ran).toEqual([]);
    });

    it.each(WINDOW_TOOLS)('%s says it is not available on this host, and nothing is forwarded, run or kept', async (name) => {
        for (const connected of [false, true]) {
            const r = rigHere(connected, NONE);
            const result = await r.byName(name).handler({} as JsonObject, ctx());
            expect(result).toEqual({ text: notAvailableHere(name, 'a Genie window'), isError: true });
            expect(result.text).not.toMatch(/open Genie|next opened/i);
            expect(r.forwarded).toEqual([]);
            expect(r.kept).toEqual([]);
            expect(r.ran).toEqual([]);
        }
    });

    it('the host\'s own tools still run there (CONTROL)', async () => {
        const r = rigHere(false, NONE);
        expect(await r.byName('agentinbox').handler({}, ctx())).toEqual({ text: 'agentinbox ran here', isError: false });
    });

    it.each([['given', { window: true, browser: true }], ['absent', undefined]] as const)('CONTROL: capabilities %s on an Electron host — today\'s wording and forwarding, unchanged', async (_how, capabilities) => {
        const closed = rigHere(false, capabilities);
        expect(await closed.byName('sites').handler({} as JsonObject, ctx())).toEqual({ text: windowClosedRefusal('sites'), isError: true });
        expect(await closed.byName('pages').handler({} as JsonObject, ctx())).toEqual({ text: windowClosedRefusal('pages'), isError: true });
        const opened = await closed.byName('openFileForUser').handler({ path: 'a' } as JsonObject, ctx());
        expect(opened).toEqual({ text: "Genie's window is closed; the file opens when Genie is next opened.", isError: false });
        expect(closed.kept).toHaveLength(1);
        const open = rigHere(true, capabilities);
        expect(await open.byName('pages').handler({} as JsonObject, ctx())).toEqual({ text: 'window ran pages', isError: false });
        expect(await open.byName('sites').handler({} as JsonObject, ctx())).toEqual({ text: 'window ran sites', isError: false });
    });
});
