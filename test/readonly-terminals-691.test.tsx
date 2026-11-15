// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyWorkspace, terminalOpened, type TerminalTab } from '../src/core/workspace-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { WindowScope } from '../src/core/workspace-window.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, NO_TERMINALS, type GenieBridge, type GenieSnapshot } from '../src/renderer/bridge.js';
import { readOnlyTerminals } from '../src/renderer/read-only-terminals.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import type { TerminalPaneProps } from '../src/renderer/components/TerminalPane.js';

/**
 * A READ-ONLY WORKSPACE SHARE'S TERMINALS SHOW OUTPUT ONLY (Tynn #691; the gap #690 left). The host already refuses a
 * read-only guest's keystrokes; the window must not offer them: the terminal is drawn read-only (no input), typing and
 * resizing send nothing, and there is no way to open or close a terminal. A window that may act keeps all of it
 * (positive control).
 */

/** A terminal's write goes on the next tick (local-terminal-client.ts terminalAction): let it, before reading what was sent. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function spyTerminals() {
    const sent: Array<{ method: string; args: unknown[] }> = [];
    const record = (method: string) => (...args: unknown[]) => { sent.push({ method, args }); };
    const bridge: GenieBridge['terminals'] = {
        ...NO_TERMINALS,
        open: (...args: unknown[]) => { sent.push({ method: 'open', args }); return Promise.resolve({ id: 'term_new', pid: 1, shell: 'sh' }) as never; },
        write: record('write'),
        resize: record('resize'),
        close: record('close'),
        list: () => Promise.resolve([]),
    };
    return { bridge, sent };
}

describe('the read-only terminals bridge sends nothing that acts', () => {
    it('open, write, resize and close never reach the host; reading still does', async () => {
        const { bridge, sent } = spyTerminals();
        const ro = readOnlyTerminals(bridge);
        ro.write('term_t', 'ls\r');
        ro.resize('term_t', 80, 24);
        ro.close('term_t');
        await expect(ro.open('tynn', { cols: 80, rows: 24 })).rejects.toThrow(/read-only/);
        expect(sent).toEqual([]);
        expect(await ro.list('tynn')).toEqual([]);
        // CONTROL: the same calls on the bridge itself do reach it.
        bridge.write('term_t', 'ls\r');
        expect(sent).toEqual([{ method: 'write', args: ['term_t', 'ls\r'] }]);
    });
});

describe('the Terminals view, read-only and not', () => {
    const tab: TerminalTab = { id: 'term_t', workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null };
    const state = terminalOpened(emptyWorkspace(), tab, 'hello\r\n');
    const workspace = { id: 'tynn', name: 'tynn', path: '/w/tynn' };

    function render(readOnly: boolean, initialState = state) {
        const { bridge, sent } = spyTerminals();
        const panes: TerminalPaneProps[] = [];
        const Pane = (props: TerminalPaneProps) => { panes.push(props); return <div data-terminal-pane={props.paneId} />; };
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(<Workspace view="terminals" workspace={workspace} terminals={bridge} files={NO_FILES} initialState={initialState} terminalPane={Pane} readOnly={readOnly} />);
        return { container, panes, sent };
    }

    it('read-only: the pane takes no input, and typing or resizing sends nothing', async () => {
        const { container, panes, sent } = render(true);
        expect(container.querySelector('[data-terminal-pane="term_t"]')).not.toBeNull();
        expect(panes.at(-1)?.readOnly).toBe(true);
        panes.at(-1)!.onData('ls\r');
        panes.at(-1)!.onResize({ cols: 80, rows: 24 });
        await settled();
        expect(sent).toEqual([]);
    });

    it('read-only: no way to open or close a terminal', () => {
        const { container } = render(true);
        expect(container.querySelector('[data-terminal-add]')).toBeNull();
        expect(container.querySelector('[data-terminal-close]')).toBeNull();
        expect(render(true, emptyWorkspace()).container.querySelector('[data-terminal-add-empty]')).toBeNull();
    });

    it('a window that may act keeps input, open and close (CONTROL)', async () => {
        const { container, panes, sent } = render(false);
        expect(panes.at(-1)?.readOnly).toBe(false);
        panes.at(-1)!.onData('ls\r');
        await settled();
        expect(sent).toContainEqual({ method: 'write', args: ['term_t', 'ls\r'] });
        expect(container.querySelector('[data-terminal-add]')).not.toBeNull();
        expect(container.querySelector('[data-terminal-close]')).not.toBeNull();
        expect(render(false, emptyWorkspace()).container.querySelector('[data-terminal-add-empty]')).not.toBeNull();
    });
});

describe('a read-only workspace window’s Terminals view, through the Shell', () => {
    const row = (over: Partial<AgentRow>): AgentRow => ({ id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over });
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents: [row({ id: 'a_atlas', name: 'atlas' })], workspaces: [{ id: 'tynn', name: 'Tynn', path: '/w/tynn', agentsKnown: true }] as GenieSnapshot['workspaces'], deckItems: [] };
    const render = (windowScope: WindowScope) => {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
            <Shell route="genie://workspace/tynn?view=terminals" windowScope={windowScope} snapshot={snapshot} servable={['workspace', 'agent']} agentDetail={null} agentResolved={false} selectedRowId={null}
                chatThread={null} pinned={null} files={NO_FILES} terminals={NO_TERMINALS} onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}}
                onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} />,
        );
        return container;
    };
    it('offers no terminal to open when read-only; a control share does (CONTROL)', () => {
        expect(render({ kind: 'workspace', workspaceId: 'tynn', readonly: false }).querySelector('[data-terminal-add-empty]')).not.toBeNull();
        expect(render({ kind: 'workspace', workspaceId: 'tynn', readonly: true }).querySelector('[data-terminal-add-empty]')).toBeNull();
        expect(render({ kind: 'workspace', workspaceId: 'tynn', readonly: true }).querySelector('[data-terminal-empty]')).not.toBeNull();
    });
});
