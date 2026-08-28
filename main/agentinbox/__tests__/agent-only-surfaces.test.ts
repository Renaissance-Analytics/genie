import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AMS AgentInbox is agent-to-agent only. Workspace channels were removed by
 * owner decision; keeping an IPC or remote HTTP route alive would preserve a
 * second, hidden product surface even after the MCP schema stopped advertising
 * it.
 */
describe('AgentInbox agent-only host surfaces', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

    it('does not expose channel list, clear, or channel-history IPC handlers', () => {
        const source = read('main/ipc.ts');

        expect(source).not.toContain("'agentinbox:channels'");
        expect(source).not.toContain("'agentinbox:clear-channel'");
        expect(source).not.toContain('channelKey?: string');
    });

    it('does not expose channel routes through the remote desktop API', () => {
        const source = read('main/mobile/api.ts');

        expect(source).not.toContain('/api/desktop/agentinbox/channels');
        expect(source).not.toContain('/api/desktop/agentinbox/clear');
        expect(source).not.toContain('channelKey?: string');
    });

    it('renders an agent/DM inbox without loading or selecting channels', () => {
        const source = read('renderer/components/Master/AgentInboxFlyout.tsx');

        expect(source).not.toContain('agentInbox.channels()');
        expect(source).not.toContain("kind: 'channel'");
        expect(source).not.toContain('clearChannel(');
    });
});
