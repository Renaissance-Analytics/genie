// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { MobileShell } from '../src/renderer/components/MobileShell.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ghost = { id: 'ghost', name: 'Hibernated project', path: '/ghost', asleep: true, agentsKnown: false };
const snapshot = { ...EMPTY_SNAPSHOT, agents: [], workspaces: [{ id: 'awake', name: 'Active project', path: '/awake', asleep: false, agentsKnown: true }], hibernatedWorkspaces: [ghost], deckItems: [], workstation: { name: 'test', healthy: true } } as GenieSnapshot;
let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.innerHTML = ''; localStorage.clear(); });
const shell = (route: string) => <Shell route={route} snapshot={snapshot} servable={['dashboard', 'deck', 'agent', 'workspace', 'flows', 'knowledge', 'settings']}
    agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
    onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}}
    onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} />;

describe('story394: the sidebar is the only ghost-workspace surface', () => {
    it.each(['genie://dashboard', 'genie://deck', 'genie://flows', 'genie://knowledge', 'genie://settings'])('%s only renders a ghost in the explicitly expanded sidebar', (route) => {
        localStorage.setItem('genie.rail.showHibernated', '1');
        const container = document.createElement('div'); container.innerHTML = renderToStaticMarkup(shell(route));
        const rail = container.querySelector('[data-rail]');
        expect(rail?.textContent).toContain('Hibernated project');
        rail?.remove();
        expect(container.textContent).not.toContain('Hibernated project');
        expect(container.querySelector('[data-workspace="ghost"], [data-agent-workspace="ghost"]')).toBeNull();
    });
    it('does not force an asleep workspace into the sidebar merely because its old route is current', () => {
        const html = renderToStaticMarkup(<Sidebar route="genie://workspace/ghost" deckCount={0} workspaces={[ghost as never]} onNavigate={() => {}} />);
        expect(html).not.toContain('data-workspace="ghost"');
        expect(html).toContain('data-rail-tool="hibernated"');
    });
    it('redocks an explicitly shown ghost through its callback instead of navigating into stale data', () => {
        localStorage.setItem('genie.rail.showHibernated', '1');
        const navigate = vi.fn(), wake = vi.fn();
        const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        const props = { route: 'genie://dashboard', deckCount: 0, workspaces: [ghost], onNavigate: navigate, onWakeWorkspace: wake } as unknown as Parameters<typeof Sidebar>[0];
        act(() => root!.render(<Sidebar {...props} />));
        const entry = container.querySelector<HTMLElement>('[data-workspace="ghost"]'); expect(entry).not.toBeNull();
        act(() => entry!.click());
        expect(wake).toHaveBeenCalledWith('ghost');
        expect(navigate).not.toHaveBeenCalled();
    });
    it('the phone’s workspace picker only receives active workspaces, not the separate sidebar metadata', () => {
        const html = renderToStaticMarkup(<MobileShell host="test" locked={false} refusal={null} items={[]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} agents={null} workspaces={snapshot.workspaces} onSelectWorkspace={() => {}} />);
        expect(html).toContain('Active project');
        expect(html).not.toContain('Hibernated project');
    });
});
