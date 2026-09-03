import { describe, expect, it } from 'vitest';
import { planHandoff } from '../handoff';

/**
 * The operator's handoff note used to be dropped, every single time.
 *
 * `onHandoff` early-returned on `SYSTEM_WORKSPACE_ID` with "the System workspace
 * has no project folder — Genie has nowhere to file a handoff for it". It was a
 * truthful refusal of a false premise: the operator DID have a folder, it simply
 * had no row pointing at one. It has both now, so the note lands in
 * `~/.gosa/.ai/handoff/genie.md` on the same path every other agent uses.
 *
 * The decision is pure and lives here so the refusals can be asserted without
 * standing up the whole MCP server; `onHandoff` is the thin wrapper that hands it
 * the two live lookups and then writes.
 */

const systemRow = { id: '__system__', project_name: 'System', path: '/home/w/.gosa' };
const projectRow = { id: 'ws-1', project_name: 'Demo', path: '/src/demo' };
const lookup = (id: string) =>
    id === '__system__' ? systemRow : id === 'ws-1' ? projectRow : undefined;

const osaSpec = {
    workspace_id: '__system__',
    meta: { agent_id: 'genie:workstation', whisper_purpose: 'genie' },
};

describe('planning where an agent handoff is filed', () => {
    it('files the workstation operator note in its own envelope', () => {
        expect(planHandoff(osaSpec, lookup)).toEqual({
            ok: true,
            workspaceRoot: '/home/w/.gosa',
            agentName: 'genie',
            relPath: '.ai/handoff/genie.md',
        });
    });

    it('POSITIVE CONTROL — an ordinary workspace agent is unaffected', () => {
        const spec = { workspace_id: 'ws-1', meta: { agent_id: 'a1', whisper_purpose: 'frontend' } };

        expect(planHandoff(spec, lookup)).toEqual({
            ok: true,
            workspaceRoot: '/src/demo',
            agentName: 'frontend',
            relPath: '.ai/handoff/frontend.md',
        });
    });

    it('refuses a terminal attached to no workspace, and says why', () => {
        const loose = { workspace_id: null, meta: { whisper_purpose: 'x' } };
        const plan = planHandoff(loose, lookup);

        expect(plan.ok).toBe(false);
        expect(plan.ok === false && plan.reason).toMatch(/not attached/i);
    });

    it('refuses when the workspace row has no path on disk', () => {
        const plan = planHandoff({ workspace_id: 'ws-2', meta: { whisper_purpose: 'x' } }, () => ({
            id: 'ws-2',
            project_name: 'Pathless',
            path: '',
        }));

        expect(plan.ok).toBe(false);
        expect(plan.ok === false && plan.reason).toMatch(/no path/i);
    });

    it('refuses an agent with no name — a handoff is filed under the name', () => {
        const plan = planHandoff({ workspace_id: 'ws-1', meta: {} }, lookup);

        expect(plan.ok).toBe(false);
        expect(plan.ok === false && plan.reason).toMatch(/no agent name/i);
    });
});
