import { describe, expect, it } from 'vitest';
import { agentSidecarScreen } from '../agent-sidecar-screen';
import type { AgentRecordSpec, AgentRuntimeSpec } from '../ams-grid';
import type { TerminalSpec } from '../genie';

const agent = (id: string, over: Partial<AgentRecordSpec> = {}): AgentRecordSpec => ({
    id,
    name: id,
    purpose: '',
    avatar: null,
    role: 'specialized',
    collisionGroup: null,
    allowedTuis: [],
    ...over,
});

const runtime = (agentId: string, terminalSpecId: string): AgentRuntimeSpec => ({
    id: `runtime-${agentId}`,
    agentId,
    tui: 'claude',
    terminalSpecId,
    fronted: true,
});

const spec = (id: string): TerminalSpec =>
    ({ id, type: 'terminal', meta: { agent: 'claude' } }) as TerminalSpec;

describe('agentSidecarScreen', () => {
    it('joins a driver to the separate sidecar agent terminal', () => {
        const driver = agent('driver', { sidecarAgentId: 'slave' });
        const slave = agent('slave', { driverAgentId: 'driver' });
        expect(
            agentSidecarScreen({
                owner: driver,
                agents: [driver, slave],
                runtimes: [runtime('driver', 'driver-term'), runtime('slave', 'slave-term')],
                specs: [spec('driver-term'), spec('slave-term')],
            }),
        ).toMatchObject({ target: 'sidecar', agent: { id: 'slave' }, spec: { id: 'slave-term' } });
    });

    it('joins the sidecar screen back to its driver', () => {
        const driver = agent('driver', { sidecarAgentId: 'slave' });
        const slave = agent('slave', { driverAgentId: 'driver' });
        expect(
            agentSidecarScreen({
                owner: slave,
                agents: [driver, slave],
                runtimes: [runtime('driver', 'driver-term'), runtime('slave', 'slave-term')],
                specs: [spec('driver-term'), spec('slave-term')],
            }),
        ).toMatchObject({ target: 'driver', agent: { id: 'driver' }, spec: { id: 'driver-term' } });
    });

    it('offers no screen for a dormant sidecar with no terminal', () => {
        const driver = agent('driver', { sidecarAgentId: 'slave' });
        const slave = agent('slave', { driverAgentId: 'driver' });
        expect(
            agentSidecarScreen({
                owner: driver,
                agents: [driver, slave],
                runtimes: [runtime('driver', 'driver-term')],
                specs: [spec('driver-term')],
            }),
        ).toBeNull();
    });
});
