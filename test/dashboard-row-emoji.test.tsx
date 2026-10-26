import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ROW_EMOJI, isGenieAction } from '../src/core/agent-signals.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { withActionSignal } from '../src/main/mcp-signal.js';
import type { Registration } from '../src/main/mcp-tools.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * AN AGENT'S ROW SHOWS WHAT IT JUST DID WITH GENIE (genie#1209; the owner, 2026-10-26: "I also want to see a thumbsUp
 * emoji on a agent row when an agent uses thumbsUp. We also need an emoji for imDone and an emoji for when an agent
 * performs any genie based action like opening a terminal, managing the workspace tabs, setting up bg process and
 * sites"). thumbsUp already reached the window (`genie:action` thumbsup, for its sound); imDone and every other Genie tool
 * did not. Every registered tool is wrapped once: a call that SUCCEEDED, by a known agent, signals its row. Talking tools
 * have their own signals (mail, the Deck), so they are not "a Genie action".
 */

describe('which emoji', () => {
    it('👍 thumbsUp, ✅ imDone, 🧞 a Genie action', () => {
        expect(ROW_EMOJI).toEqual({ thumbsup: '👍', done: '✅', genie: '🧞' });
    });

    it('terminals, tabs, processes, sites, services, pages, flows, agents, files are Genie actions; talking and reading are not', () => {
        for (const tool of ['manageTerminals', 'workspaceTabs', 'processes', 'sites', 'services', 'pages', 'flows', 'createAgent', 'openFileForUser']) expect(isGenieAction(tool)).toBe(true);
        for (const tool of ['agentinbox', 'thumbsUp', 'imDone', 'ForceTheQuestion', 'checkIssues', 'knowledge', 'lists', 'plan']) expect(isGenieAction(tool)).toBe(false);
    });
});

describe('every Genie tool call signals its agent’s row', () => {
    const tool = (name: string, isError = false): Registration => ({
        definition: { name, description: '', inputSchema: { type: 'object' } } as never,
        handler: (async () => ({ content: [{ type: 'text', text: 'x' }], isError })) as unknown as Registration['handler'],
    });
    const callers: Record<string, { agentId: string }> = { 'sess-kai': { agentId: 'agent_kai' } };
    const call = async (regs: readonly Registration[], name: string, session: string | null = 'sess-kai') => {
        const r = regs.find((x) => x.definition.name === name)!;
        await r.handler({}, { headers: session ? { 'genie-session': session } : {} } as never);
    };

    it('a successful action → genie with the tool; imDone → done; a failed call, a talking tool or an unknown caller → nothing', async () => {
        const seen: Array<{ agentId: string; kind: string; tool: string }> = [];
        const regs = withActionSignal([tool('manageTerminals'), tool('imDone'), tool('sites', true), tool('agentinbox'), tool('workspaceTabs')], (id) => callers[id] ?? null, (agentId, kind, name) => seen.push({ agentId, kind, tool: name }));
        await call(regs, 'manageTerminals');
        await call(regs, 'imDone');
        await call(regs, 'sites');
        await call(regs, 'agentinbox');
        await call(regs, 'workspaceTabs', 'sess-stranger');
        expect(seen).toEqual([
            { agentId: 'agent_kai', kind: 'genie', tool: 'manageTerminals' },
            { agentId: 'agent_kai', kind: 'done', tool: 'imDone' },
        ]);
    });

    it('the wrapped tool still answers exactly what it answered, and keeps its definition and visibility', async () => {
        const original = tool('pages');
        const visible = () => true;
        const [wrapped] = withActionSignal([{ ...original, visible }], () => null, () => {});
        expect(wrapped!.definition).toBe(original.definition);
        expect(wrapped!.visible).toBe(visible);
        expect(await wrapped!.handler({}, { headers: {} } as never)).toEqual({ content: [{ type: 'text', text: 'x' }], isError: false });
    });
});

describe('the row', () => {
    const row = (id: string): AgentRow => ({
        id, name: id, workspaceId: 'ws', state: 'working', provider: 'claude', fidelity: 'declared', duration: null,
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    } as AgentRow);

    it('draws the agent’s latest emoji on ITS row only', () => {
        const html = renderToStaticMarkup(<Dashboard
            workspaces={[{ id: 'ws', name: 'ws', path: '/ws' }]} rows={[row('kai'), row('wren')]} genie={null}
            onOpenAgent={() => {}} onAddAgent={() => {}} rowEmoji={{ kai: '🧞' }}
        />);
        const kai = html.slice(html.indexOf('data-agent="kai"'), html.indexOf('data-agent="wren"'));
        const wren = html.slice(html.indexOf('data-agent="wren"'));
        expect(kai).toContain('data-row-emoji="🧞"');
        expect(wren).not.toContain('data-row-emoji');
    });
});
