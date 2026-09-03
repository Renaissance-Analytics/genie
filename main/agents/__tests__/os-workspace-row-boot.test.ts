import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../../agentinbox/broker';
import { agentInboxJoinInputFor } from '../../agentinbox/join-input';
import { SYSTEM_WORKSPACE_ROW_ID } from '../../workspace/system-workspace-id';

const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'background.ts'), 'utf8');

/**
 * The operator's spec carries a real `workspace_id`, and the ROW it points at
 * exists before it does.
 *
 * `terminal_specs.workspace_id` is a foreign key. Seeding the operator's spec
 * before `ensureSystemWorkspace` would fail the insert on a cold boot — on the
 * one machine state (a brand-new install) nobody tests by hand.
 */
describe('boot seeds the System Workspace row before the operator spec', () => {
    it('ensures the row first', () => {
        const row = boot.indexOf('ensureSystemWorkspace(');
        const spec = boot.indexOf('id: GENIE_OS_TERMINAL_ID');

        // Both present, or this asserts nothing.
        expect(row).toBeGreaterThan(-1);
        expect(spec).toBeGreaterThan(-1);
        expect(row).toBeLessThan(spec);
    });

    it('migrates the legacy envelope before anything reads the new one', () => {
        const ensure = boot.indexOf('ensureGenieOsWorkspace(');
        const row = boot.indexOf('ensureSystemWorkspace(');

        expect(ensure).toBeGreaterThan(-1);
        expect(ensure).toBeLessThan(row);
    });

    it('no longer seeds or re-parents the operator to a null workspace', () => {
        // The whole point. A `workspace_id: null` on the operator's spec is the
        // shape every deleted substitution existed to paper over.
        const start = boot.indexOf('id: GENIE_OS_TERMINAL_ID');
        const seed = boot
            .slice(start, start + 2500)
            // Comments explain the migration FROM `workspace_id: null`; the code
            // must not still be doing it.
            .replace(/^\s*\/\/.*$/gm, '');

        expect(seed).toContain('workspace_id: SYSTEM_WORKSPACE_ROW_ID');
        expect(seed).not.toContain('workspace_id: null');
    });
});

/**
 * ...and with that spec, the operator joins the inbox on the ordinary path.
 *
 * AgentInbox identity is `workspaceId:purpose`. The operator was never in
 * `agentInboxBroker.directory()` at boot because `joinInputFromSpec` refused a
 * null `workspace_id` — so the upgrade broadcast, built from that directory,
 * reached every agent except the machine's own operator. This walks the real
 * path: spec → join input → broker.
 */
describe('the operator joins AgentInbox like any other agent', () => {
    const lookup = (id: string) =>
        id === SYSTEM_WORKSPACE_ROW_ID
            ? { id, project_name: 'System', path: '/home/w/.gosa' }
            : id === 'ws-1'
              ? { id: 'ws-1', project_name: 'Demo', path: '/src/demo' }
              : undefined;

    const osaSpec = {
        id: 'genie-workstation-agent',
        workspace_id: SYSTEM_WORKSPACE_ROW_ID,
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
        meta: {
            agent: 'claude',
            agent_id: 'inbox-uuid-1',
            whisper_purpose: 'frontend',
            whisper_scope: 'self',
        },
    };

    it('is in the broker directory after a boot rehydrate, and can see itself', () => {
        const broker = new AgentInboxBroker();
        const inputs = [osaSpec, projectSpec]
            .map((spec) => agentInboxJoinInputFor(spec, lookup))
            .filter((input): input is NonNullable<typeof input> => input !== null);

        broker.rehydrate(inputs);

        expect(inputs).toHaveLength(2);
        expect(broker.getInfo('genie:workstation')).toBeTruthy();
    });

    it('POSITIVE CONTROL — an ordinary workspace agent still rehydrates beside it', () => {
        const broker = new AgentInboxBroker();
        broker.rehydrate(
            [osaSpec, projectSpec]
                .map((spec) => agentInboxJoinInputFor(spec, lookup))
                .filter((input): input is NonNullable<typeof input> => input !== null),
        );

        expect(broker.getInfo('inbox-uuid-1')).toBeTruthy();
    });
});
