import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE AGENT HEADER STAYS ONE LINE (the Windows VM's own screenshot, 2026-10-14: at 1024px with the chat pinned,
 * "genie2-vm /" broke onto two lines and the "claude · ACP" chip wrapped). The crumb, name, chip and pill never wrap
 * or shrink below their words — the crumb truncates — and the long working-directory path is what gives way.
 */
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: 'C:/Users/example/work/a-long-workspace-folder/repos/app', instructions: null };
const idle = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const html = renderToStaticMarkup(<AgentView agent={agent} session={idle} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} onTakeOver={() => {}} workspace={{ id: 'ws', name: 'genie2-vm', path: '/w/ws' }} />);
// The crumb is a LINK to the workspace since Tynn #805 (a button); the chip and pill are spans.
const classOf = (attr: RegExp): string[] => (html.match(new RegExp(`<(?:span|button) ${attr.source}[^>]*class="([^"]*)"`))?.[1] ?? '').split(' ');

describe('the agent header', () => {
    it('the crumb never wraps — it truncates instead', () => {
        const c = classOf(/data-crumb="ws"/);
        expect(c).toContain('whitespace-nowrap');
        expect(c).toContain('truncate');
    });

    it('the provider chip and the state pill never wrap and never shrink', () => {
        for (const c of [classOf(/data-provider-chip="claude"/), classOf(/data-pill="[^"]*"/)]) {
            expect(c).toContain('whitespace-nowrap');
            expect(c).toContain('shrink-0');
        }
    });

    /*
     * AT 1024PX WITH THE CHAT PINNED the header is ~286px wide (the 520px chat and the 208px rail take the rest) — measured
     * on omarchy-test by the layout sweep: the crumb squeezed to 0px and the header spilled 426px past its box. The title
     * pieces sit in one cluster that may shrink and clips; the crumb and the name truncate but keep a few letters; the
     * action buttons never wrap, and drop their words (icon, aria-label and title stay) when the header is narrow.
     */
    it('the title pieces share one cluster that shrinks and clips, so the header never spills', () => {
        const cluster = html.match(/<div data-header-title=""[^>]*class="([^"]*)"/)?.[1]?.split(' ') ?? [];
        for (const c of ['min-w-0', 'flex-1', 'overflow-hidden']) expect(cluster).toContain(c);
        expect(html).toMatch(/<div data-view-header=""[^>]*class="[^"]*@container/);
    });

    it('the crumb and the name truncate but never vanish', () => {
        const crumb = classOf(/data-crumb="ws"/);
        const name = html.match(/<span data-agent-name=""[^>]*class="([^"]*)"/)?.[1]?.split(' ') ?? [];
        for (const c of [crumb, name]) {
            expect(c).toContain('truncate');
            expect(c.some((k) => /^min-w-(?:\d|\[)/.test(k)), c.join(' ')).toBe(true);
        }
    });

    it('the action buttons never wrap; their words give way to the icon in a narrow header, which keeps their name', () => {
        const take = html.match(/<button [^>]*data-action="take-over"[^>]*>/)?.[0] ?? '';
        expect(take).toMatch(/whitespace-nowrap/);
        expect(take).toMatch(/aria-label="Take over"/);
        expect(html).toMatch(/data-action="take-over"[^>]*>(?:(?!<\/button>).)*<span class="@max-\[46rem\]:hidden">Take over/);
    });

    it('the working-directory path is what gives way: it may shrink to nothing and truncates', () => {
        const path = html.match(/<span class="([^"]*)" title="C:\/Users\/example[^"]*"/)?.[1]?.split(' ') ?? [];
        expect(path).toContain('min-w-0');
        expect(path).toContain('truncate');
    });
});
