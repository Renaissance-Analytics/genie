import { describe, expect, it } from 'vitest';
import { claudeChannelBridge } from '../agent-config';

/**
 * The AgentInbox channel server's INITIALIZE response.
 *
 * Agents across the estate report `genie-agentinbox-channel` "failing to
 * connect" — including this session's own client, which listed it among the
 * servers that failed. The script itself is fine: run by hand it starts, answers
 * `initialize`, and exits cleanly. What it answers WITH is wrong.
 *
 * It advertised `experimental` as a SIBLING of `capabilities`:
 *
 *     result: { protocolVersion, capabilities: {}, serverInfo, experimental: {…} }
 *
 * MCP puts `experimental` INSIDE `capabilities`. So a client reading the
 * handshake sees an EMPTY capability set and no `claude/channel` at all, and
 * declines a channel server that cannot do channels. The capability was
 * declared in a place nothing looks.
 *
 * Asserted against the generated source rather than by booting the script,
 * because the failure is in what the text says — and the text is what ships into
 * every workspace's `.agents/_genie/`.
 */
describe('the Claude AgentInbox channel handshake', () => {
    const bridge = claudeChannelBridge();

    it('declares the channel capability INSIDE capabilities', () => {
        // The whole bug: a capability outside `capabilities` is invisible.
        expect(bridge).toMatch(/capabilities:\s*\{\s*experimental:\s*\{\s*'claude\/channel'/);
    });

    it('never leaves capabilities empty', () => {
        // `capabilities: {}` is what the client actually saw, and it is the
        // reason a working server read as a broken one.
        expect(bridge).not.toMatch(/capabilities:\s*\{\}/);
    });

    it('still answers with the client’s protocol version', () => {
        // Positive control: the handshake must remain a real handshake. Pinning
        // only the capability shape would pass against a server that stopped
        // negotiating a version at all.
        expect(bridge).toContain('protocolVersion');
        expect(bridge).toContain("message.params?.protocolVersion");
    });

    it('still identifies itself', () => {
        expect(bridge).toContain("name: 'genie-agentinbox-channel'");
    });
});
