import { describe, expect, it } from 'vitest';
import { agentInboxJoinInputFor } from '../join-input';
import { SYSTEM_WORKSPACE_ID } from '../../terminal/workspace-of-terminal';

/**
 * genie#352 — the workstation operator was never rehydrated into the inbox.
 *
 * `joinInputFromSpec` refused any spec with a null `workspace_id`, and the OSA
 * is the ONE agent that always has one: it is deliberately not a workspace
 * agent, so that deleting a project cannot delete or re-parent it. The result is
 * that `agentInboxBroker.directory()` does not contain `genie:workstation` at
 * boot — which is why the upgrade broadcast, built from that directory, reached
 * every agent except the machine's own operator.
 *
 * genie#321 already established the resolution: a system spec IS in a
 * workspace — the synthetic one — and `callerWorkspaceDescriptor` says so. The
 * MCP path has resolved it that way since; the boot rehydrate had not caught up.
 */
const osaSpec = {
    id: 'genie-workstation-agent',
    workspace_id: null,
    label: 'Genie',
    meta: {
        system: true,
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
    id === 'ws-1' ? { id: 'ws-1', project_name: 'Demo', path: '/src/demo' } : undefined;

describe('rehydrating an AgentInbox identity from a terminal spec', () => {
    it('resolves the workstation operator into the System Workspace', () => {
        const input = agentInboxJoinInputFor(osaSpec, lookup);

        expect(input).toMatchObject({
            agentId: 'genie:workstation',
            terminalId: 'genie-workstation-agent',
            workspaceId: SYSTEM_WORKSPACE_ID,
            purpose: 'genie',
        });
    });

    it('POSITIVE CONTROL — a terminal genuinely in no workspace is still refused', () => {
        // Without this, "resolve the null workspace" degrades into "register
        // every loose terminal as an agent", which is the leak #321 closed.
        const loose = { ...osaSpec, meta: { ...osaSpec.meta, system: false } };

        expect(agentInboxJoinInputFor(loose, lookup)).toBeNull();
    });

    it('still refuses a spec that is not an agent at all', () => {
        const notAnAgent = { ...projectSpec, meta: { agent: 'claude' } };

        expect(agentInboxJoinInputFor(notAnAgent, lookup)).toBeNull();
    });

    it('resolves an ordinary project agent unchanged', () => {
        expect(agentInboxJoinInputFor(projectSpec, lookup)).toMatchObject({
            agentId: 'uuid-1',
            workspaceId: 'ws-1',
            workspaceName: 'Demo',
            purpose: 'frontend',
        });
    });

    it('refuses a project spec whose workspace row is gone', () => {
        expect(agentInboxJoinInputFor(projectSpec, () => undefined)).toBeNull();
    });
});
