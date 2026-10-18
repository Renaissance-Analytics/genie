import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HOST_TOOLS, TOOL_GROUPS, groupTools, toneLabel, type ToolStatus } from '../src/core/toolchain.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE TOOLCHAIN, GROUPED AND HONEST (the owner, 2026-10-18, with a screenshot of a flat list where half the rows read
 * "unknown": "the items managed by the toolchain should be grouped by their type … User should be able to install and
 * update from this ux"). TC1 of .ai/_discovery/genie-2-toolchain-versions.md:
 *
 * - grouped: Languages and runtimes, Package managers, Version control, Containers, Agent CLIs — every tool in one;
 * - no "unknown": that word was Genie's missing source for the newest version, not the tool's state. A row with no
 *   known latest shows its version and an Update button (the tool's own update path finds the newest); a row whose
 *   update is known says "Update to X"; a current one says "Up to date".
 */
const status = (tool: string, installed: string | null, latest: string | null, tone: ToolStatus['tone']): ToolStatus => ({ tool, installed, latest, tone, source: null } as ToolStatus);
const render = (tools: ToolStatus[]) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: { tools, checkedAt: 1 } as FeatureData['toolchain'] }} onAction={() => {}} onNavigate={() => {}} />);

describe('the groups', () => {
    it('every tool Genie manages is in exactly one group (COUNTED against HOST_TOOLS)', () => {
        const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
        expect([...grouped].sort()).toEqual(HOST_TOOLS.map((t) => t.name).sort());
        expect(new Set(grouped).size).toBe(grouped.length);
    });

    it('groups a scan in the table’s order, empty groups dropped, an unknown tool under Other', () => {
        const out = groupTools([status('codex', '0.1', null, 'unknown'), status('php', '8.4', null, 'unknown'), status('mystery', '1', null, 'unknown')]);
        expect(out.map((g) => g.label)).toEqual(['Languages and runtimes', 'Agent CLIs', 'Other']);
        expect(out[0]!.tools.map((t) => t.tool)).toEqual(['php']);
    });
});

describe('the words', () => {
    it('no "unknown": a missing latest has no badge; the others say what they mean', () => {
        expect(toneLabel('unknown')).toBeNull();
        expect(toneLabel('update-available')).toBe('Update available');
        expect(toneLabel('up-to-date')).toBe('Up to date');
        expect(toneLabel('not-installed')).toBe('Not installed');
    });
});

describe('the surface', () => {
    const scan = [
        status('php', '8.4.24', '8.5.11', 'update-available'),
        status('composer', '2.10.2', null, 'unknown'),
        status('node', '24.22.0', '24.22.0', 'up-to-date'),
        status('git', '2.56.0', null, 'unknown'),
        status('claude-code', '2.1.301', null, 'unknown'),
        status('docker', '29.7.2', null, 'unknown'),
    ];

    it('one section per group, in order, each with its heading', () => {
        const html = render(scan);
        const order = [...html.matchAll(/data-tool-group="([a-z-]+)"/g)].map((m) => m[1]);
        expect(order).toEqual(['languages', 'package-managers', 'version-control', 'containers', 'agents']);
        expect(html).toMatch(/Languages and runtimes[\s\S]*Package managers[\s\S]*Version control[\s\S]*Containers[\s\S]*Agent CLIs/);
    });

    it('never the word "unknown"; every installed tool can be updated from here (COUNTED: six rows, six actions)', () => {
        const html = render(scan);
        expect(html).not.toMatch(/>unknown</);
        expect(html).toMatch(/Update to 8\.5\.11/);
        expect(html).toMatch(/Up to date/);
        // php: "Update to"; node: current, no button; the four with no known latest: "Update".
        expect(html.match(/data-action="toolchain-update"/g)).toHaveLength(5);
    });
});
