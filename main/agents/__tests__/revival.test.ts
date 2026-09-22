import { describe, expect, it } from 'vitest';
import { agentsToRevive } from '../revival';

describe('agentsToRevive', () => {
    const running = { id: 'running', type: 'terminal', workspace_id: 'ws', meta: { agent: 'claude', agent_id: 'a', was_running: true } };
    it.each([
        ['stopped', { ...running, id: 'skip', meta: { ...running.meta, user_stopped: true } }],
        ['never ran', { ...running, id: 'skip', meta: { ...running.meta, was_running: undefined } }],
        ['exited', { ...running, id: 'skip', meta: { ...running.meta, was_running: false } }],
        ['operator', { ...running, id: 'skip', meta: { ...running.meta, agent_id: 'genie:workstation' } }],
        ['plain shell', { ...running, id: 'skip', meta: { was_running: true } }],
    ])('skips %s and still revives the running agent', (_name, skipped) => {
        expect(agentsToRevive([skipped, running]).map(s => s.id)).toEqual(['running']);
    });
});
