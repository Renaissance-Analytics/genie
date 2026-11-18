import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * THE AGENT'S BAR STAYS ONE LINE (the Windows VM's own screenshot, 2026-10-14: at 1024px with the chat pinned, the header
 * broke onto two lines and the "claude · ACP" chip wrapped). REWRITTEN for the one bar (the owner on beta.64, 2026-11-17):
 * the agent's page has no header of its own; its workspace's tab strip is its bar, and its state, views and actions sit at
 * the strip's right end. The tabs give way first (they scroll inside the bar); the chip and the pill never wrap or shrink;
 * the actions are named icons with no words to wrap; the long working-directory path is a tooltip, never a column.
 */
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: 'C:/Users/example/work/a-long-workspace-folder/repos/app', instructions: null };
const idle = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const html = renderToStaticMarkup(
    <AgentView agent={agent} session={idle} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} onTakeOver={() => {}} workspace={{ id: 'ws', name: 'genie2-vm', path: '/w/ws' }}
        bar={(trailing) => <WorkspaceTabs designed={{ tabs: [] }} agents={[{ id: 'a1', name: 'atlas', state: 'idle' }]} current={{ kind: 'agent', id: 'a1' }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} trailing={trailing} path={agent.cwd} />} />,
);
// The opening tag that carries `attr`, its attributes in any order (react-fancy's Button renders its class first).
const classOf = (attr: RegExp): string[] => {
    const open = html.match(new RegExp(`<(?:span|button|div|nav)\\b[^>]*${attr.source}[^>]*>`))?.[0] ?? '';
    return (/\sclass="([^"]*)"/.exec(open)?.[1] ?? '').split(' ');
};

describe('the agent\'s bar', () => {
    it('the provider chip and the state pill never shrink; the pill never wraps (the chip is its logo alone)', () => {
        expect(classOf(/data-provider-chip="claude"/)).toContain('shrink-0');
        const pill = classOf(/data-pill="[^"]*"/);
        expect(pill).toContain('whitespace-nowrap');
        expect(pill).toContain('shrink-0');
    });

    /*
     * WHAT GIVES WAY (measured in a real window by scripts/one-bar-proof.mjs: at 1600px with the chat pinned the right end
     * squeezed the agent's own tab out of view; at 1024px it spilled 56px): in a bar under 64rem the pulse hides and a running
     * pill shows its dot and clock (the words its tooltip); the tabs scroll and keep at least 6rem; in a column too narrow
     * for both (1024px with the chat pinned leaves the page ~296px) the right end moves to a line of its own and wraps
     * there, rather than spill.
     */
    it('the tabs scroll and keep 6rem; the right end may shrink, and wraps on a line of its own rather than spill', () => {
        const bar = classOf(/data-top-bar=""/);
        for (const c of ['flex-wrap', 'min-h-8', '@container']) expect(bar).toContain(c);
        const tabs = classOf(/data-bar-tabs=""/);
        for (const c of ['min-w-[6rem]', 'flex-1', 'overflow-x-auto', 'h-[31px]']) expect(tabs).toContain(c);
        const end = classOf(/data-bar-trailing=""/);
        for (const c of ['shrink', 'min-w-0', 'max-w-full', 'flex-wrap']) expect(end).toContain(c);
    });

    it('in a narrow bar the pulse hides and a running pill keeps its dot and clock, its words on hover', () => {
        const working = { ...idle, turnState: 'working' } as LiveSession;
        const h = renderToStaticMarkup(<AgentView agent={agent} session={working} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 62_000} workspace={{ id: 'ws', name: 'genie2-vm', path: '/w/ws' }} />);
        const word = h.match(/data-pill="([^"]*)"/)?.[1] ?? '';
        expect(word).toMatch(/^Turn 3/);
        // A clock runs, so the words hide below 64rem and stay as the pill's tooltip.
        expect(h).toContain(`data-pill="${word}" title="${word}"`);
        expect(h).toContain(`<span class="@max-[64rem]:hidden">${word}</span><span class="font-mono`);
        // CONTROL: an idle pill has no clock, so its words never hide.
        const idleWord = html.match(/data-pill="([^"]*)"/)?.[1] ?? '';
        expect(html).toContain(`<span>${idleWord}</span>`);
        // The pulse's slot hides in a narrow bar.
        expect(h).toContain('items-center @max-[64rem]:hidden"');
    });

    it('the actions are icons named for a screen reader and on hover: nothing to wrap', () => {
        const take = html.match(/<button [^>]*data-action="take-over"[^>]*>/)?.[0] ?? '';
        expect(take).toMatch(/aria-label="Take over"/);
        expect(take).toMatch(/title="Take over \(⌘⇧T\)"/);
        expect(html).not.toMatch(/data-action="take-over"[^>]*>(?:(?!<\/button>).)*>Take over</);
    });

    it('the working-directory path is the agent tab\'s tooltip, not a column that could push anything', () => {
        expect(html).not.toContain('data-header-path');
        expect(html).toMatch(/data-workspace-tab="agent:a1"[^>]*title="atlas · idle · C:\/Users\/example\/work\/a-long-workspace-folder\/repos\/app"|title="atlas · idle · C:\/Users\/example[^"]*"[^>]*data-workspace-tab="agent:a1"/);
    });
});
