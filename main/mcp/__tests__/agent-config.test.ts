import { describe, expect, it } from 'vitest';
import { applyGenieServer, GENIE_SERVER_NAME } from '../agent-config';

const entry = { type: 'http', url: '${GENIE_MCP_URL}' };

describe('applyGenieServer', () => {
    it('adds the genie server to an empty/new config', () => {
        expect(applyGenieServer(null, entry, true)).toEqual({
            mcpServers: { genie: entry },
        });
    });

    it('merges alongside existing servers without clobbering them', () => {
        const existing = {
            mcpServers: { other: { command: 'x' } },
            someOtherKey: 1,
        };
        expect(applyGenieServer(existing, entry, true)).toEqual({
            mcpServers: { other: { command: 'x' }, genie: entry },
            someOtherKey: 1,
        });
    });

    it('removes only the genie entry on disable, keeping the rest', () => {
        const existing = {
            mcpServers: { other: { command: 'x' }, genie: entry },
        };
        expect(applyGenieServer(existing, entry, false)).toEqual({
            mcpServers: { other: { command: 'x' } },
        });
    });

    it('returns null when disabling and no config exists (nothing to write)', () => {
        expect(applyGenieServer(null, entry, false)).toBeNull();
    });

    it('disabling an existing config with no genie entry leaves it intact', () => {
        const existing = { mcpServers: { other: { command: 'x' } } };
        expect(applyGenieServer(existing, entry, false)).toEqual(existing);
    });

    it('uses the literal env-ref url (resolved per-terminal, not baked in)', () => {
        const out = applyGenieServer(null, entry, true) as {
            mcpServers: Record<string, { url: string }>;
        };
        expect(out.mcpServers[GENIE_SERVER_NAME].url).toBe('${GENIE_MCP_URL}');
    });
});
