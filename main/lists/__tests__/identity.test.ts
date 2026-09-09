import { describe, expect, it } from 'vitest';
import { agentListSummary, liveTerminalForAgent, planListOwner } from '../identity';

/**
 * WHO a list belongs to, and what an unfinished one says on the way out.
 *
 * Both halves are pure on purpose. "Which agent is this" and "does an empty
 * list add anything to imDone" are the two questions the feature gets wrong in
 * the ways that are hardest to see later — a list silently attached to the
 * wrong owner, and a ping that grows a line of noise for every agent that has
 * nothing to say.
 */

const spec = (over: Partial<{ workspace_id: string | null; meta: unknown }> = {}) => ({
    workspace_id: 'ws-1',
    meta: { whisper_purpose: 'lists' },
    ...over,
});

describe('planListOwner — the same identity rule the handoff note uses', () => {
    it('names the workspace and the AGENT NAME', () => {
        expect(planListOwner(spec())).toEqual({
            ok: true,
            workspaceId: 'ws-1',
            agentName: 'lists',
        });
    });

    it('refuses a terminal with no workspace, and says why', () => {
        const r = planListOwner(spec({ workspace_id: null }));
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(r.reason).toMatch(/workspace/i);
    });

    it('refuses a terminal with no agent name, and says why', () => {
        const r = planListOwner(spec({ meta: { whisper_purpose: '   ' } }));
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        // The reason has to explain the identity, not just report a missing
        // field — an agent reading it needs to know a terminal id would not do.
        expect(r.reason).toMatch(/name/i);
    });

    it('trims the name so "lists " and "lists" are ONE list, not two', () => {
        expect(planListOwner(spec({ meta: { whisper_purpose: '  lists  ' } }))).toMatchObject({
            agentName: 'lists',
        });
    });
});

describe('liveTerminalForAgent — where a nudge for this agent goes today', () => {
    const terminals = [
        { id: 't-dead', workspace_id: 'ws-1', meta: { whisper_purpose: 'lists' } },
        { id: 't-live', workspace_id: 'ws-1', meta: { whisper_purpose: 'lists' } },
        { id: 't-other', workspace_id: 'ws-1', meta: { whisper_purpose: 'osa' } },
        { id: 't-elsewhere', workspace_id: 'ws-2', meta: { whisper_purpose: 'lists' } },
    ];
    const isLive = (id: string) => id !== 't-dead';

    it('finds the agent’s live terminal by name within its workspace', () => {
        expect(liveTerminalForAgent(terminals, isLive, 'ws-1', 'lists')).toBe('t-live');
    });

    it('never crosses into another workspace', () => {
        // Positive control: the same name IS found in ws-2 when asked for ws-2.
        expect(liveTerminalForAgent(terminals, isLive, 'ws-2', 'lists')).toBe('t-elsewhere');
        expect(liveTerminalForAgent(terminals, isLive, 'ws-3', 'lists')).toBeNull();
    });

    it('returns null when the agent is not running — a relaunch mints a new terminal', () => {
        expect(liveTerminalForAgent(terminals, () => false, 'ws-1', 'lists')).toBeNull();
    });
});

describe('agentListSummary — what rides the imDone ping', () => {
    it('adds NOTHING for an agent with an empty list', () => {
        // The ping already carries a handoff line, IssueWatch counts, mail and
        // an FTQ reminder. An agent that keeps no list must not pay a line for
        // it, or every imDone in the workspace grows one.
        expect(agentListSummary([])).toBeNull();
    });

    it('lists what is still open, and says it is the agent’s own list', () => {
        const line = agentListSummary([{ text: 'ship the PR' }, { text: 'reply to lead' }]);
        expect(line).not.toBeNull();
        expect(line).toContain('ship the PR');
        expect(line).toContain('reply to lead');
        expect(line).toMatch(/AgentList/);
        // It has to name the count, so an agent that is about to stop sees at a
        // glance that it is stopping with work still on its own list.
        expect(line).toContain('2');
    });

    it('says "1 item" not "1 items"', () => {
        expect(agentListSummary([{ text: 'one thing' }])).toMatch(/1 item\b/);
    });
});
