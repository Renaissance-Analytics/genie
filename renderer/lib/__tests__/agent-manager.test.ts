import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    agentManagerTabs,
    mcpDriftNotice,
    mcpRowAction,
    personaIsDirty,
    sidecarSummary,
    type PersonaDraft,
} from '../agent-manager';
import type { AgentManagerSidecar, AgentManagerState } from '../genie';

/**
 * The agent manager's decisions, tested where they live.
 *
 * Tynn #709. The renderer has no DOM harness, so — as everywhere else in
 * `renderer/lib` — the surface's judgement calls live in a pure module and the
 * `.tsx` only draws what this returns. That is what makes "the MCP list shows N
 * servers" checkable at all.
 *
 * Every list assertion below is PAIRED with a differently-shaped agent. A view
 * model that ignored its input and returned the same tabs, the same banner or
 * the same buttons every time would pass a single-fixture suite perfectly, and
 * the bug it hides — a surface that looks right and reports the wrong agent — is
 * exactly the one this whole feature exists to end.
 */

function state(over: Partial<AgentManagerState> = {}): AgentManagerState {
    return {
        ok: true,
        agent: {
            id: 'a-moic',
            workspaceId: 'ws-1',
            name: 'moic',
            purpose: 'agent management',
            avatar: null,
            role: 'specialized',
            tui: 'claude',
            running: true,
            isSidecar: false,
            terminalSpecId: 'term-moic',
        },
        persona: {
            path: '/ws/.agents/moic/AGENT.md',
            exists: true,
            name: 'moic',
            purpose: 'agent management',
            scope: 'repos/genie',
            tuis: ['claude', 'codex'],
            avatar: null,
            body: 'You are moic.\n',
            extra: [{ key: 'model', value: 'opus' }],
        },
        mcp: {
            source: 'claude',
            configPath: '.mcp.json',
            servers: [
                {
                    name: 'genie',
                    source: 'claude',
                    detail: 'http://127.0.0.1:8317/mcp/a',
                    required: true,
                    managed: true,
                },
                {
                    name: 'playwright',
                    source: 'claude',
                    detail: 'npx @playwright/mcp',
                    required: false,
                    managed: false,
                },
            ],
            drift: 'unproven',
            editable: true,
        },
        sidecar: {
            id: 'a-slave',
            name: 'moic-slave',
            exists: true,
            running: false,
            terminalSpecId: null,
            actions: ['start'],
            matchedBy: 'name',
        },
        ...over,
    } as AgentManagerState;
}

describe('agentManagerTabs', () => {
    it('offers identity, prompt, MCP and sidecar', () => {
        // The gap the owner reported: the old surface was identity ONLY.
        expect(agentManagerTabs(state()).map((t) => t.id)).toEqual([
            'identity',
            'prompt',
            'mcp',
            'sidecar',
        ]);
    });

    it('POSITIVE CONTROL: a SIDECAR gets no sidecar tab', () => {
        // A sidecar has no sidecar. A tab that acts on nothing is worse than an
        // absent one — it looks like it did something. Paired with the test
        // above so a hard-coded four-tab list cannot pass both.
        const asSidecar = state();
        asSidecar.agent!.isSidecar = true;
        asSidecar.sidecar = {
            id: null,
            name: null,
            exists: false,
            running: false,
            terminalSpecId: null,
            actions: [],
            matchedBy: null,
        };
        expect(agentManagerTabs(asSidecar).map((t) => t.id)).toEqual([
            'identity',
            'prompt',
            'mcp',
        ]);
    });

    it('counts the MCP servers on the MCP tab', () => {
        expect(agentManagerTabs(state()).find((t) => t.id === 'mcp')?.badge).toBe('2');
    });

    it('POSITIVE CONTROL: a different server set gives a different count', () => {
        // "shows N servers" is unfalsifiable against one fixture.
        const lean = state();
        lean.mcp!.servers = [lean.mcp!.servers[0]!];
        expect(agentManagerTabs(lean).find((t) => t.id === 'mcp')?.badge).toBe('1');
    });

    it('has no tabs at all when the agent could not be read', () => {
        expect(agentManagerTabs({ ok: false, agent: null, persona: null, mcp: null, sidecar: null } as AgentManagerState)).toEqual([]);
    });
});

describe('mcpDriftNotice', () => {
    it('warns — and offers a restart — when the session provably predates the config', () => {
        // The afternoon this cost: a change to `.mcp.json` does not reach a
        // running session, and NOTHING said so.
        const notice = mcpDriftNotice(state({ mcp: { ...state().mcp!, drift: 'stale' } }).mcp!);
        expect(notice.tone).toBe('warn');
        expect(notice.canRestart).toBe(true);
        expect(notice.text).toMatch(/restart/i);
    });

    it('still explains the load-at-start rule when it cannot prove drift', () => {
        // Not a warning — a fact the human needs before they wonder why their
        // edit did nothing. Claiming "up to date" here would be a claim the data
        // does not support.
        const notice = mcpDriftNotice(state().mcp!);
        expect(notice.tone).toBe('info');
        expect(notice.text).toMatch(/session start/i);
        expect(notice.text).not.toMatch(/up to date/i);
    });

    it('says nothing about drift for an agent that is not running', () => {
        const notice = mcpDriftNotice(state({ mcp: { ...state().mcp!, drift: 'not-running' } }).mcp!);
        expect(notice.tone).toBe('none');
        expect(notice.canRestart).toBe(false);
    });
});

describe('mcpRowAction', () => {
    it('REFUSES to remove the genie server, with the reason on the control', () => {
        const action = mcpRowAction(state().mcp!.servers[0]!, true);
        expect(action.canRemove).toBe(false);
        expect(action.reason).toMatch(/genie/i);
    });

    it('POSITIVE CONTROL: an ordinary server can be removed', () => {
        // Otherwise a guard that refused everything would pass the test above.
        const action = mcpRowAction(state().mcp!.servers[1]!, true);
        expect(action.canRemove).toBe(true);
        expect(action.reason).toBeNull();
    });

    it('refuses every removal in a config Genie does not rewrite', () => {
        // Codex keeps its servers in a TOML file Genie writes only a fenced
        // block of. Offering a button that cannot work is a lie.
        const action = mcpRowAction(state().mcp!.servers[1]!, false);
        expect(action.canRemove).toBe(false);
        expect(action.reason).toMatch(/codex|file/i);
    });
});

describe('personaIsDirty', () => {
    const loaded = state().persona!;
    const draft = (over: Partial<PersonaDraft> = {}): PersonaDraft => ({
        purpose: loaded.purpose,
        scope: loaded.scope ?? '',
        tuis: loaded.tuis,
        body: loaded.body,
        ...over,
    });

    it('is clean when nothing was typed', () => {
        // Opening an agent must not present an enabled Save.
        expect(personaIsDirty(loaded, draft())).toBe(false);
    });

    it('notices an edited prompt', () => {
        expect(personaIsDirty(loaded, draft({ body: 'You are moic, revised.\n' }))).toBe(true);
    });

    it('notices an edited header field', () => {
        expect(personaIsDirty(loaded, draft({ purpose: 'the agent manager' }))).toBe(true);
    });

    it('notices a cleared scope', () => {
        // Clearing scope back to the whole workspace is a real edit, and an
        // empty string comparing equal to null would silently discard it.
        expect(personaIsDirty(loaded, draft({ scope: '' }))).toBe(true);
    });

    it('notices a driver added or removed', () => {
        expect(personaIsDirty(loaded, draft({ tuis: ['claude'] }))).toBe(true);
    });

    it('POSITIVE CONTROL: reordering the same drivers is not an edit', () => {
        // Otherwise "dirty" would fire on every render that rebuilt the array,
        // and Save would always look enabled — which is the same as no signal.
        expect(personaIsDirty(loaded, draft({ tuis: ['codex', 'claude'] }))).toBe(false);
    });
});

/**
 * The MCP tab's Restart must be the GRACEFUL one.
 *
 * `agents.start` on an agent with a bound terminal REATTACHES it
 * (`startRegisteredAgent` → `reattachSavedAgent`, 'warm' when live). It reloads
 * nothing and reports success — which is the exact silence this tab exists to
 * end, dressed up as a fix. `terminalSpec.restartAgent` is the one that
 * relaunches with the provider's resume grammar so the TUI re-reads its MCP
 * config and the conversation survives (wish #88).
 *
 * SOURCE-LEVEL for the component half: this lane has no DOM harness (see
 * `vitest.config.ts`), and the precedent for pinning a component's decision off
 * its source is `agent-restart-gate.test.ts` next door. `e2e/agent-manager.spec.ts`
 * covers the behaviour.
 */
describe('the MCP drift Restart control', () => {
    const SRC = readFileSync(
        path.resolve(__dirname, '../../components/Master/AgentManager.tsx'),
        'utf8',
    );

    it('POSITIVE CONTROL: the source is actually read, and still has the control', () => {
        // A renamed file or moved control would make every `not.toMatch` below
        // pass forever — the classic way a source-level test rots.
        expect(SRC.length).toBeGreaterThan(500);
        expect(SRC).toMatch(/data-testid="agent-manager-restart"/);
    });

    it('calls the resume-based restart', () => {
        expect(SRC).toMatch(/terminalSpec\.restartAgent\(/);
    });

    it('never reaches for agents.start, which would reattach and reload nothing', () => {
        expect(SRC).not.toMatch(/agents\.start\(/);
    });
});

describe('sidecarSummary', () => {
    it('names the sidecar and its state', () => {
        expect(sidecarSummary(state().sidecar!)).toMatch(/moic-slave/);
        expect(sidecarSummary(state().sidecar!)).toMatch(/not running/i);
    });

    it('POSITIVE CONTROL: a running sidecar reads differently', () => {
        const running = { ...state().sidecar!, running: true };
        expect(sidecarSummary(running)).toMatch(/running/i);
        expect(sidecarSummary(running)).not.toMatch(/not running/i);
    });

    it('says plainly when there is no sidecar', () => {
        const none: AgentManagerSidecar = {
            id: null,
            name: null,
            exists: false,
            running: false,
            terminalSpecId: null,
            actions: [],
            matchedBy: null,
        };
        expect(sidecarSummary(none)).toMatch(/no sidecar/i);
    });
});
