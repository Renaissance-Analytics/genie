import { describe, expect, it } from 'vitest';
import { agentInboxJoinInputFor } from '../join-input';
import { SYSTEM_WORKSPACE_ID } from '../../terminal/workspace-of-terminal';

/**
 * AgentInbox identity is `workspaceId:purpose` — the workspace is not a scope on
 * the inbox, it is HALF THE PRIMARY KEY. That is the real reason the workstation
 * operator could never join: no workspace, no identity, and
 * `agentInboxBroker.directory()` therefore had no `genie:workstation` in it at
 * boot, so every broadcast built from that directory reached every agent except
 * the machine's own operator.
 *
 * The operator has a workspace row now (`__system__`, rooted at `~/.gosa`), so it
 * joins on the ORDINARY path with no branch of its own — the spec carries a real
 * `workspace_id` and the lookup finds a real row.
 */
const osaSpec = {
    id: 'genie-workstation-agent',
    workspace_id: SYSTEM_WORKSPACE_ID,
    label: 'Genie',
    meta: {
        agent: 'claude',
        agent_id: 'genie:workstation',
        whisper_purpose: 'genie',
        whisper_scope: 'all',
    },
};

const projectSpec = {
    id: 'term-1',
    workspace_id: 'ws-1',
    label: 'claude · demo',
    meta: { agent: 'claude', agent_id: 'uuid-1', whisper_purpose: 'frontend', whisper_scope: 'self' },
};

const lookup = (id: string) =>
    id === 'ws-1'
        ? { id: 'ws-1', project_name: 'Demo', path: '/src/demo' }
        : id === SYSTEM_WORKSPACE_ID
          ? { id: SYSTEM_WORKSPACE_ID, project_name: 'System', path: '/home/w/.gosa' }
          : undefined;

describe('rehydrating an AgentInbox identity from a terminal spec', () => {
    it('joins the workstation operator through its own workspace row', () => {
        const input = agentInboxJoinInputFor(osaSpec, lookup);

        expect(input).toMatchObject({
            agentId: 'genie:workstation',
            terminalId: 'genie-workstation-agent',
            workspaceId: SYSTEM_WORKSPACE_ID,
            workspaceName: 'System',
            slug: 'system',
            purpose: 'genie',
        });
    });

    it('POSITIVE CONTROL — an ordinary project agent resolves unchanged', () => {
        expect(agentInboxJoinInputFor(projectSpec, lookup)).toMatchObject({
            agentId: 'uuid-1',
            workspaceId: 'ws-1',
            workspaceName: 'Demo',
            purpose: 'frontend',
        });
    });

    it('still refuses a terminal genuinely in no workspace', () => {
        // Without this, "resolve the operator" degrades into "register every
        // loose terminal as an agent", which is the leak #321 closed.
        const loose = { ...osaSpec, workspace_id: null, meta: { ...osaSpec.meta, system: true } };

        expect(agentInboxJoinInputFor(loose, lookup)).toBeNull();
    });

    it('still refuses a spec that is not an agent at all', () => {
        const notAnAgent = { ...projectSpec, meta: { agent: 'claude' } };

        expect(agentInboxJoinInputFor(notAnAgent, lookup)).toBeNull();
    });

    it('refuses a project spec whose workspace row is gone', () => {
        expect(agentInboxJoinInputFor(projectSpec, () => undefined)).toBeNull();
    });
});
