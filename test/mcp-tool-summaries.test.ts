import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../src/main/genie-catalog.js';
import { MCP_FAMILIES, describeMcpTool, filterMcpTools, groupMcpTools, toolFamily, toolSummary } from '../src/core/mcp-tool-summaries.js';

/**
 * AGENT MCP, THE TOOLS AS DATA (Tynn #718): every builtin tool's catalog definition carries a short human `summary` (one
 * line, written, never a cut of the model-facing text) and belongs to a family; the list filters and groups with counts.
 */
describe('every builtin tool has a written one-line summary', () => {
    it('present, one line, short, and not the model text', () => {
        expect(BUILTIN_TOOLS.length).toBeGreaterThanOrEqual(18);
        for (const t of BUILTIN_TOOLS) {
            expect(typeof t.summary, t.name).toBe('string');
            expect(t.summary.length, t.name).toBeGreaterThan(8);
            expect(t.summary.length, t.name).toBeLessThanOrEqual(80);
            expect(t.summary, t.name).not.toMatch(/\n/);
            expect(t.summary, t.name).not.toBe(t.description);
            expect(t.summary, t.name).not.toMatch(/…|\.\.\.$/);
        }
    });

    it('every builtin falls in a named family other than apps', () => {
        for (const t of BUILTIN_TOOLS) expect(['attention', 'messaging', 'workspace'], t.name).toContain(toolFamily(t.name));
    });
});

describe('families', () => {
    it('the four, in order, each with a label and an icon', () => {
        expect(MCP_FAMILIES.map((f) => f.id)).toEqual(['attention', 'messaging', 'workspace', 'apps']);
        for (const f of MCP_FAMILIES) { expect(f.label.length).toBeGreaterThan(2); expect(f.icon.length).toBeGreaterThan(2); }
    });
    it('the named ones; anything else (a plugin’s tool) is apps', () => {
        expect(toolFamily('imDone')).toBe('attention');
        expect(toolFamily('agentinbox')).toBe('messaging');
        expect(toolFamily('sites')).toBe('workspace');
        expect(toolFamily('ai.genie.spreadsheet.createWorkbook')).toBe('apps');
    });
});

describe('describeMcpTool', () => {
    it('a builtin gets its written summary and family', () => {
        const d = describeMcpTool('imDone', 'A long model-facing paragraph. With a second sentence.');
        expect(d.family).toBe('attention');
        expect(d.summary).not.toBe('A long model-facing paragraph.');
        expect(d.description).toBe('A long model-facing paragraph. With a second sentence.');
    });
    it('an unknown tool’s summary is the description’s first sentence, whole', () => {
        expect(toolSummary('ai.x.thing', 'Makes the thing. Then more words.')).toBe('Makes the thing.');
        expect(describeMcpTool('ai.x.thing', 'Makes the thing. Then more words.').family).toBe('apps');
    });
});

describe('filter and group', () => {
    const tools = [
        describeMcpTool('imDone', 'x.'), describeMcpTool('thumbsUp', 'x.'), describeMcpTool('agentinbox', 'x.'),
        describeMcpTool('sites', 'x.'), describeMcpTool('ai.genie.spreadsheet.createWorkbook', 'Make a workbook.'),
    ];
    it('groups in family order with counts; empty families are left out', () => {
        const g = groupMcpTools(tools);
        expect(g.map((x) => [x.family, x.tools.length])).toEqual([['attention', 2], ['messaging', 1], ['workspace', 1], ['apps', 1]]);
        expect(groupMcpTools(tools.slice(0, 1)).map((x) => x.family)).toEqual(['attention']);
    });
    it('the filter matches name, summary and description, case-blind; empty keeps all', () => {
        expect(filterMcpTools(tools, '').length).toBe(5);
        expect(filterMcpTools(tools, 'IMDONE').map((t) => t.name)).toEqual(['imDone']);
        expect(filterMcpTools(tools, 'workbook').map((t) => t.name)).toEqual(['ai.genie.spreadsheet.createWorkbook']);
        expect(filterMcpTools(tools, 'zzzz')).toEqual([]);
    });
});
