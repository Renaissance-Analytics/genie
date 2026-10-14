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
const html = renderToStaticMarkup(<AgentView agent={agent} session={idle} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'ws', name: 'genie2-vm', path: '/w/ws' }} />);
const classOf = (attr: RegExp): string[] => (html.match(new RegExp(`<span ${attr.source}[^>]*class="([^"]*)"`))?.[1] ?? '').split(' ');

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

    it('the working-directory path is what gives way: it may shrink to nothing and truncates', () => {
        const path = html.match(/<span class="([^"]*)" title="C:\/Users\/example[^"]*"/)?.[1]?.split(' ') ?? [];
        expect(path).toContain('min-w-0');
        expect(path).toContain('truncate');
    });
});
