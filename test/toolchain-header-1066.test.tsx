import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { toolchainProblems } from '../src/renderer/toolchain-view.js';

/**
 * Tynn #1066, from the fresh-Windows shots (the coordinator's review, 2026-11-26):
 * - the toolbar's "Fix 2 problems" wrapped under the counts on one page and not on another, as "Checked just now" grew
 *   into "Checked 8m ago": the controls are ONE group, kept together on the right;
 * - with a tool's panel open (the cards hidden), the page said "2 need you / Fix 2 problems" and nothing on screen said
 *   which: the problems are named beside the panel too.
 */
type Tc = NonNullable<FeatureData['toolchain']>;
const t = (tool: string, installed: string | null, tone: ToolStatus['tone'], extra: Partial<ToolStatus> = {}): ToolStatus => ({ tool, installed, latest: null, tone, source: null, ...extra });
const VM: Tc = {
    tools: [t('claude-code', null, 'broken', { problem: 'there is no `claude` program on this machine’s PATH' }), t('codex', null, 'broken', { problem: 'there is no `codex` program on this machine’s PATH' }), t('git', '2.52.0', 'up-to-date')],
    checkedAt: 1,
    php: { managed: [{ version: '8.5.13', dir: '/t/8.5.13', usedBy: [] }], system: null, available: [{ version: '8.6.0', installed: false }] },
    defaults: { php: '8.5.13', node: null, go: null, python: null, dotnet: null, rust: null, ruby: null, java: null },
};
const render = (selected?: string) =>
    renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: VM }} onAction={() => {}} onNavigate={() => {}} {...(selected ? { selected } : {})} />);
const between = (html: string, from: string, to: string) => {
    const a = html.indexOf(from);
    return a < 0 ? '' : html.slice(a, to ? html.indexOf(to, a + from.length) : undefined);
};

describe('the toolbar keeps its controls together', () => {
    it('Checked …, Check for updates, Check and repair and Fix N problems are one group that does not wrap', () => {
        const html = render();
        const group = between(html, 'data-toolchain-actions=', 'data-toolchain-body');
        expect(group).toContain('data-toolchain-checked');
        expect(group).toContain('data-action="toolchain-check-updates"');
        expect(group).toContain('Check and repair');
        expect(group).toContain('data-action="toolchain-fix-all"');
        expect(group).toMatch(/^data-toolchain-actions="[^"]*" class="[^"]*\bflex-nowrap\b/);
    });
});

describe('with a tool’s panel open, the problems are still named', () => {
    it('the panel side names both problems (Claude Code, Codex), each with its button', () => {
        const aside = between(render('php'), 'data-toolchain-aside', '');
        expect(aside).toContain('data-toolchain-problems="2"');
        expect(aside).toContain('data-problem="claude-code"');
        expect(aside).toContain('data-problem="codex"');
    });
});


describe('a CLI that is not installed is offered Install, not Repair (the fresh-Windows shots)', () => {
    it('not installed → "Install"; installed and broken → "Repair"', () => {
        const tc: Tc = { ...VM, tools: [t('claude-code', null, 'broken', { problem: 'there is no `claude` program on this machine’s PATH' }), t('codex', '0.71.0', 'broken', { problem: 'it exits at start' })] };
        const problems = toolchainProblems(tc);
        const claude = problems.find((p) => p.key === 'claude-code')!;
        const codex = problems.find((p) => p.key === 'codex')!;
        expect(claude.label).toBe('Install');
        expect(claude.title).toBe("Claude Code isn't installed");
        expect(codex.label).toBe('Repair');
        expect(codex.title).toBe("Codex can't run");
    });
});
