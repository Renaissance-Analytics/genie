// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsSections, type SettingsFacts } from '../src/core/agent-settings-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { RailItem } from '../src/core/rail-view.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE AGENTS SIDEBAR'S TERMINAL BUTTON (Tynn #851). The owner: "this terminal button in the agents sidebar should open a
 * terminal to the workspace, not start the TUI version of the agent. that access should be in the settings because it's a
 * diagnostics ui only really and used for logins."
 *
 * - The row's terminal button opens a SHELL in the agent's WORKSPACE, in a window of its own: the workspace header's
 *   Terminal button's path (Tynn #378, `scratchTerminal`). It never calls Take Over.
 * - The agent's TUI (Take Over) is in the agent's Settings → General, said to be for diagnostics and logins.
 *
 * Interaction is a claim about a live DOM, so the clicks run in happy-dom through the real Shell → Sidebar wiring.
 */

const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const AGENTS: AgentRow[] = [
    row({ id: 'a_tynn', name: 'tynn-one', workspaceId: 'tynn' }),
    row({ id: 'a_fancy', name: 'fancy-one', workspaceId: 'fancy', state: 'working' }),
];

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    window.localStorage.clear();
    window.localStorage.setItem('genie.rail.view', 'agents');
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
});
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const click = (el: Element | null | undefined) => { act(() => { (el as HTMLElement).click(); }); };
const terminalButton = (agentId: string) => host.querySelector<HTMLButtonElement>(`[data-agent-open-terminal="${agentId}"]`);

describe('the sidebar row’s terminal button, through the Shell', () => {
    const snapshot: GenieSnapshot = {
        ...EMPTY_SNAPSHOT,
        agents: AGENTS,
        workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
        deckItems: [],
        signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
        workstation: { name: 'alphar', healthy: true },
    };
    let takeOvers: string[];
    let shells: string[];
    let navigated: string[];
    const mount = (over: Record<string, unknown> = {}) => {
        takeOvers = []; shells = []; navigated = [];
        act(() => root.render(
            <Shell
                route="genie://dashboard" snapshot={snapshot} servable={['dashboard', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
                selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES} onNavigate={(r) => navigated.push(r)} onOpenAgent={() => {}} onAddAgent={() => {}}
                onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onToggleFilesPin={() => {}} onCloseChat={() => {}}
                answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
                onTakeOver={(id: string) => { takeOvers.push(id); }}
                onOpenScratchTerminal={async (workspaceId: string) => { shells.push(workspaceId); return { ok: true as const }; }}
                {...over}
            />,
        ));
    };

    it('opens a shell in the AGENT’S WORKSPACE, never the agent’s TUI', async () => {
        mount();
        const button = terminalButton('a_fancy');
        expect(button, 'the row’s terminal button').not.toBeNull();
        click(button);
        await flush();
        expect(shells).toEqual(['fancy']);
        expect(takeOvers).toEqual([]);
        expect(navigated).toEqual([]);
    });

    it('each row opens its own workspace (control: a different agent, a different workspace)', async () => {
        mount();
        click(terminalButton('a_tynn'));
        await flush();
        expect(shells).toEqual(['tynn']);
        expect(takeOvers).toEqual([]);
    });

    it('a window that cannot open a workspace shell draws the button disabled — it does not fall back to Take Over', async () => {
        mount({ onOpenScratchTerminal: undefined });
        const button = terminalButton('a_fancy');
        expect(button?.disabled).toBe(true);
        click(button);
        await flush();
        expect(takeOvers).toEqual([]);
        expect(navigated).toEqual([]);
    });
});

describe('the Dashboard row’s Open window → Terminal, through the Shell (Tynn #851, the owner’s screenshot)', () => {
    // It opened a whole second Genie window — rail, chat, and a workspace panel saying "No terminals open in Tynn" — not a
    // terminal. It is the same door as the sidebar button: a shell in the row's workspace, in a window of its own.
    const snapshot: GenieSnapshot = {
        ...EMPTY_SNAPSHOT,
        agents: AGENTS,
        workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
        deckItems: [],
        signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
        workstation: { name: 'alphar', healthy: true },
    };
    let shells: string[];
    let popOuts: string[];
    let takeOvers: string[];
    let files: string[];
    const mount = (over: Record<string, unknown> = {}) => {
        shells = []; popOuts = []; takeOvers = []; files = [];
        act(() => root.render(
            <Shell
                route="genie://dashboard" snapshot={snapshot} servable={['dashboard', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
                selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES} onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}}
                onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onToggleFilesPin={() => {}} onCloseChat={() => {}}
                answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
                onTakeOver={(id: string) => { takeOvers.push(id); }}
                onOpenScratchTerminal={async (workspaceId: string) => { shells.push(workspaceId); return { ok: true as const }; }}
                {...({ onPopOutTerminals: (id: string) => { popOuts.push(id); } } as Record<string, unknown>)}
                onPopOutFiles={(id: string) => { files.push(id); }}
                {...over}
            />,
        ));
    };
    const trigger = (agent: string) => host.querySelector<HTMLButtonElement>(`[data-agent="${agent}"] [data-windows-menu]`);
    const item = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === label);

    it('Terminal opens a SHELL in the row’s workspace — never a Genie window on its Terminals view, never the TUI', async () => {
        mount();
        click(trigger('a_fancy'));
        click(item('Terminal'));
        await flush();
        expect(shells).toEqual(['fancy']);
        expect(popOuts, 'a second Genie window').toEqual([]);
        expect(takeOvers).toEqual([]);
    });

    it('CONTROL: Files still opens the row’s Files window', async () => {
        mount();
        click(trigger('a_tynn'));
        click(item('Files'));
        await flush();
        expect(files).toEqual(['tynn']);
        expect(shells).toEqual([]);
    });

    it('a window that cannot open a workspace shell has no live Terminal entry — it does not fall back to a Genie window', async () => {
        mount({ onOpenScratchTerminal: undefined });
        click(trigger('a_fancy'));
        const terminal = item('Terminal');
        if (terminal) click(terminal);
        await flush();
        expect(popOuts).toEqual([]);
        expect(shells).toEqual([]);
    });
});

describe('the button’s words', () => {
    const ws = (id: string, name: string): RailItem => ({
        id, path: `/w/${id}`, name, count: 1, alert: null, processes: 'running', processesTitle: '1 process', sites: 'running', sitesTitle: '1 site', working: 0, color: 'teal',
    });
    const render = (open: (workspaceId: string) => Promise<{ ok: true } | { ok: false; reason: string }>) => act(() => root.render(
        <Sidebar
            route="genie://dashboard" deckCount={0} workspaces={[ws('tynn', 'Tynn.ai'), ws('fancy', 'Fancy')]}
            available={['dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} agents={AGENTS} onChatAgent={() => {}}
            {...({ onOpenWorkspaceTerminal: open } as Record<string, unknown>)}
        />,
    ));

    it('name the WORKSPACE, not the agent: a terminal in Fancy, in a new window', () => {
        render(async () => ({ ok: true }));
        const button = terminalButton('a_fancy')!;
        expect(button.getAttribute('aria-label')).toBe('Open a terminal in Fancy (new window)');
        expect(button.getAttribute('title')).toBe('Open a terminal in Fancy (new window)');
        expect(button.getAttribute('aria-label')).not.toContain('fancy-one');
    });

    it('a shell that does not open is said on the button, never a dead click', async () => {
        render(async () => ({ ok: false, reason: 'Terminals are not ready yet.' }));
        click(terminalButton('a_fancy'));
        await flush();
        const button = terminalButton('a_fancy')!;
        expect(button.getAttribute('data-terminal-failed')).toBe('');
        expect(button.getAttribute('title')).toContain('Terminals are not ready yet.');
    });
});

describe('the agent’s TUI lives in Settings → General', () => {
    const FACTS: SettingsFacts = {
        fidelity: 'declared', provider: 'claude', ops: true, model: true, tools: true, autonomous: true, manageTabs: true,
        drivePages: true, issueWatch: true, persona: true, skills: true,
    };
    const general = (f: SettingsFacts) => settingsSections(f).find((s) => s.id === 'general')?.controls ?? [];

    it('General carries a TUI row, after Run and before Remove, when the window can open one', () => {
        expect(general({ ...FACTS, tui: true } as SettingsFacts)).toEqual(['provider', 'model', 'mode', 'run', 'tui', 'remove']);
    });

    it('CONTROL: a window that cannot open a TUI has no TUI row', () => {
        expect(general({ ...FACTS, tui: false } as SettingsFacts)).not.toContain('tui');
    });

    const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
    const ops = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetMode: () => {}, onSetAccessScope: () => {}, onSetBudget: () => {} } as unknown as AgentOpsProps;
    const view = (onTakeOver: ((id: string) => void) | undefined) => (
        <AgentView agent={agent} session={null} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null}
            onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} ops={ops}
            {...(onTakeOver ? { onTakeOver } : {})} />
    );

    it('says what it is for, in few words: “Open TUI”, for diagnostics and logins', () => {
        const html = renderToStaticMarkup(view(() => {}));
        const rowAt = html.indexOf('data-settings-row="tui"');
        expect(rowAt, 'the TUI row').toBeGreaterThan(-1);
        const rowHtml = html.slice(rowAt, html.indexOf('</div>', html.indexOf('data-action="open-tui"')));
        expect(rowHtml).toMatch(/<button[^>]*data-action="open-tui"/);
        expect(rowHtml).toContain('Open TUI');
        expect(rowHtml).toMatch(/[Dd]iagnostics and logins/);
    });

    it('pressing it does exactly what the old sidebar button did: Take Over on this agent', () => {
        const opened: string[] = [];
        act(() => root.render(view((id) => opened.push(id))));
        click(host.querySelector('[data-action="open-tui"]'));
        expect(opened).toEqual(['a1']);
    });

    it('CONTROL: a window with no Take Over draws no TUI row', () => {
        expect(renderToStaticMarkup(view(undefined))).not.toContain('data-settings-row="tui"');
    });
});
