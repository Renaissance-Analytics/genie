import { describe, expect, it } from 'vitest';
import { agentPanelActions } from '../agent-panel-actions';

describe('AgentPanel actions', () => {
    it('offers settings and restart only for agent terminals', () => {
        expect(agentPanelActions({ type: 'terminal', agent: 'codex' })).toEqual(['settings', 'restart']);
        expect(agentPanelActions({ type: 'terminal' })).toEqual([]);
        expect(agentPanelActions({ type: 'code', agent: 'codex' })).toEqual([]);
    });
});
