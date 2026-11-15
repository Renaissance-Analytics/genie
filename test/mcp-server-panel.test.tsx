import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeMcpTool } from '../src/core/mcp-tool-summaries.js';
import { McpServerPanel } from '../src/renderer/components/McpServerPanel.js';

/** SETTINGS, AGENT MCP: NOT A WALL OF TEXT (Tynn #718). */
const long = 'Tell the person you are finished. '.repeat(12).trim();
const tools = [
    describeMcpTool('imDone', long), describeMcpTool('thumbsUp', 'Show a thumbs up.'), describeMcpTool('agentinbox', 'Mail between agents.'),
    describeMcpTool('sites', 'Open sites.'), describeMcpTool('ai.genie.spreadsheet.createWorkbook', 'Make a workbook.'),
];
const verified = { ok: true as const, versions: ['2025-06-18'] };
const render = (over: Partial<Parameters<typeof McpServerPanel>[0]> = {}) => renderToStaticMarkup(<McpServerPanel url="http://127.0.0.1:4455/mcp" verified={verified} tools={tools} {...over} />);

describe('the header', () => {
    it('a status badge, the address in small mono with a copy button, the version as a small label', () => {
        const h = render();
        expect(h).toMatch(/data-mcp-status-badge="verified"/);
        expect(h).toMatch(/data-mcp-address=""[^>]*class="[^"]*font-mono[^"]*"[^>]*>http:\/\/127\.0\.0\.1:4455\/mcp</);
        expect(h).toMatch(/data-mcp-copy=""/);
        expect(h).toMatch(/data-mcp-version=""[^>]*>[^<]*2025-06-18/);
    });
    it('not listening: says so, no address, no tools', () => {
        const h = render({ url: null, verified: null });
        expect(h).toMatch(/data-mcp-status-badge="off"/);
        expect(h).not.toContain('data-mcp-address');
        expect(h).not.toContain('data-mcp-tool=');
    });
    it('listening but unverified is its own badge, with the reason', () => {
        const h = render({ verified: { ok: false, reason: 'no answer' } });
        expect(h).toMatch(/data-mcp-status-badge="unverified"/);
        expect(h).toContain('no answer');
    });
});

describe('the tools', () => {
    it('one row per tool: icon, name, the ONE-LINE summary; the long model text is NOT on screen until opened', () => {
        const h = render();
        expect(h.match(/data-mcp-tool="/g)).toHaveLength(5);
        expect(h).toMatch(/data-mcp-tool="imDone"[\s\S]*?data-mcp-tool-icon/);
        expect(h).toMatch(/data-mcp-tool="imDone"[\s\S]*?data-mcp-tool-summary=""[^>]*>[^<]+</);
        expect(h).not.toContain(long);
    });
    it('a row opens to the full description in normal body text', () => {
        const h = render({ defaultOpen: ['imDone'] });
        expect(h).toMatch(/data-mcp-tool="imDone"[\s\S]*?aria-expanded="true"/);
        expect(h).toMatch(/data-mcp-tool-description=""[^>]*>[^<]*Tell the person you are finished\./);
        expect(h.match(/data-mcp-tool-description=""/g)).toHaveLength(1);
    });
    it('grouped by family with counts, in family order', () => {
        const h = render();
        expect(h).toMatch(/data-mcp-family="attention"[\s\S]*?data-mcp-family-count=""[^>]*>2</);
        expect(h.indexOf('data-mcp-family="attention"')).toBeLessThan(h.indexOf('data-mcp-family="messaging"'));
        expect(h.indexOf('data-mcp-family="workspace"')).toBeLessThan(h.indexOf('data-mcp-family="apps"'));
    });
    it('a search filter, and a filter that matches nothing says so', () => {
        expect(render()).toMatch(/data-mcp-filter=""/);
        const none = render({ initialQuery: 'zzzz' });
        expect(none).toContain('No tool matches');
        expect(none).not.toContain('data-mcp-tool=');
        const one = render({ initialQuery: 'workbook' });
        expect(one.match(/data-mcp-tool="/g)).toHaveLength(1);
        expect(one).toMatch(/data-mcp-family="apps"/);
        expect(one).not.toContain('data-mcp-family="attention"');
    });
    it('no tool registered says so', () => {
        expect(render({ tools: [] })).toContain('No tools are registered.');
    });
});
