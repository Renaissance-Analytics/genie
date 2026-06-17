import { describe, expect, it } from 'vitest';
import {
    applyAgentsSection,
    applyGenieServer,
    claudeEntry,
    cursorEntry,
    GENIE_SERVER_NAME,
} from '../agent-config';

const URL = 'http://127.0.0.1:51717/mcp/abc123';
const entry = claudeEntry(URL);

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

    it('bakes a static literal url (no ${ENV} ref to expand)', () => {
        const out = applyGenieServer(null, entry, true) as {
            mcpServers: Record<string, { url: string }>;
        };
        expect(out.mcpServers[GENIE_SERVER_NAME].url).toBe(URL);
        expect(out.mcpServers[GENIE_SERVER_NAME].url).not.toContain('${');
    });

    it('claudeEntry sets an explicit http transport type; cursorEntry omits it', () => {
        expect(claudeEntry(URL)).toEqual({ type: 'http', url: URL });
        expect(cursorEntry(URL)).toEqual({ url: URL });
    });
});

describe('applyAgentsSection', () => {
    const BEGIN = '<!-- BEGIN GENIE MCP (auto-managed by Genie) -->';
    const END = '<!-- END GENIE MCP (auto-managed by Genie) -->';

    it('appends the genie block to the end of an existing AGENTS.md', () => {
        const out = applyAgentsSection('# My Project\n\nNotes.\n', true);
        expect(out.startsWith('# My Project\n\nNotes.\n')).toBe(true);
        expect(out).toContain(BEGIN);
        expect(out).toContain(END);
        expect(out).toContain('genieGuide');
        // beta.5: the block lists ONLY agent-callable tools — the user-run
        // initializeWorkspace prompt is gone; imDone/ForceTheQuestion/manageProcess stay.
        expect(out).toContain('imDone');
        expect(out).toContain('ForceTheQuestion');
        expect(out).toContain('manageProcess');
        expect(out).not.toContain('initializeWorkspace');
    });

    it('is idempotent — re-running does not duplicate the block', () => {
        const once = applyAgentsSection('# P\n', true);
        const twice = applyAgentsSection(once, true);
        expect(twice).toBe(once);
        expect(twice.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
    });

    it('updates the block in place when content changes, not appends', () => {
        const stale = `# P\n\n${BEGIN}\n## Genie MCP\n\nOLD BODY\n${END}\n`;
        const out = applyAgentsSection(stale, true);
        expect(out.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
        expect(out).not.toContain('OLD BODY');
        expect(out).toContain('genieGuide');
    });

    it('removes the block on disable, leaving the rest intact', () => {
        const withBlock = applyAgentsSection('# P\n\nbody\n', true);
        const out = applyAgentsSection(withBlock, false);
        expect(out).not.toContain(BEGIN);
        expect(out).toContain('# P');
        expect(out).toContain('body');
    });

    it('disable is a no-op when no block is present', () => {
        const input = '# P\n\nbody\n';
        expect(applyAgentsSection(input, false)).toBe(input);
    });
});
