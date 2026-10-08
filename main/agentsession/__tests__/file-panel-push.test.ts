import { describe, expect, it } from 'vitest';
import { DeclaredSessionStore } from '../declared-store';

describe('declared file edits announce fresh session data', () => {
    it('notifies after the tool update is stored, without waiting for pty bytes', () => {
        const statuses: string[] = [];
        const store = new DeclaredSessionStore({
            record: () => {}, now: () => 100,
            changed: () => { statuses.push(store.get('agent')!.tools[0]!.status); },
        });
        store.open({ agentId: 'agent', specId: 'spec', provider: 'claude', name: 'atlas', cwd: '/w', workspaceId: 'w' });
        store.apply('agent', { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'completed', rawInput: { file_path: '/w/a.ts' } } as never);
        expect(statuses).toEqual(['success']);
    });
});
