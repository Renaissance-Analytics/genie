import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { workspaceHome } from '../src/core/workspace-home.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { WorkspaceHome } from '../src/renderer/components/WorkspaceHome.js';

/**
 * SELECTING A WORKSPACE SHOWS ITS AGENTS. The owner, 2026-10-12, on beta.8: "when I select a workspace, I should
 * not see the workspace settings, I should see the agent lanes and all of the agents." The board's workspace
 * surface is header (name · path · agents strip · Files) over the file panel and a 320px "Agents in <name>" rail,
 * then "Changes this session". Terminals (§4.6) and the workspace's settings are the other two views of the same
 * route, reached by a labelled tab — never what the route opens on.
 */

const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: null, target: 'Wire the rail', activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });
const rows = [row({ id: 'a1', name: 'kai' }), row({ id: 'a2', name: 'wren', state: 'waiting', ask: 'Merge?' }), row({ id: 'elsewhere', workspaceId: 'fancy' })];
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    governs: { children: [], candidates: [{ id: 'fancy' }], onSet: () => {} },
    settings: { values: {}, overridden: [], onSet: () => {}, onReset: () => {} },
};
const render = (props: Partial<Parameters<typeof Workspace>[0]> = {}) =>
    renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} rows={rows} ops={ops} {...props} />);

describe('the workspace route opens on its agents', () => {
    it('home: the rail names the workspace and carries one card per agent OF THIS WORKSPACE; no settings, no terminals', () => {
        const html = render({ view: 'home' });
        expect(html).toContain('data-workspace-home="tynn"');
        expect(html).toContain('Agents in Tynn.ai');
        expect(html).toContain('data-home-agent="a1"');
        expect(html).toContain('data-home-agent="a2"');
        expect(html).not.toContain('data-home-agent="elsewhere"');
        expect((html.match(/data-home-agent="/g) ?? []).length).toBe(2);
        // The card says what the Dashboard would: the state word and the one line worth reading.
        expect(html).toContain('waiting on you');
        expect(html).toContain('Asks: Merge?');
        expect(html).not.toContain('data-workspace-settings');
        expect(html).not.toContain('data-governs');
        expect(html).not.toContain('data-terminal-tabs');
        expect(html).not.toContain('data-terminal-add');
    });

    it('home is the DEFAULT: a Workspace with no view asked for shows the agents', () => {
        const html = render();
        expect(html).toContain('data-workspace-home="tynn"');
        expect(html).not.toContain('data-workspace-settings');
    });

    it('the header carries the agents strip — a pill per agent — and the three view tabs with the current one marked', () => {
        const html = render({ view: 'home' });
        expect((html.match(/data-agent-pill="/g) ?? []).length).toBe(2);
        expect(html).toContain('data-agent-pill="a1"');
        expect(html).toMatch(/data-workspace-tab="home"[^>]*data-current="true"/);
        expect(html).toMatch(/data-workspace-tab="terminals"(?![^>]*data-current)/);
        expect(html).toMatch(/data-workspace-tab="settings"(?![^>]*data-current)/);
    });

    it('settings: the governs and settings sections, and nothing of home or the terminals', () => {
        const html = render({ view: 'settings' });
        expect(html).toContain('data-workspace-settings');
        expect(html).toContain('data-governs');
        expect(html).toMatch(/data-workspace-tab="settings"[^>]*data-current="true"/);
        expect(html).not.toContain('data-workspace-home');
        expect(html).not.toContain('data-terminal-add');
    });

    it('terminals: the strip and the pane (§4.6), and nothing of home or the settings', () => {
        const html = render({ view: 'terminals' });
        expect(html).toContain('data-terminal-tabs');
        expect(html).toContain('data-terminal-add');
        expect(html).toMatch(/data-workspace-tab="terminals"[^>]*data-current="true"/);
        expect(html).not.toContain('data-workspace-home');
        expect(html).not.toContain('data-workspace-settings');
    });

    it('a workspace with no agents says so and offers + Add agent, in the rail — not an empty list', () => {
        const html = render({ view: 'home', rows: [row({ workspaceId: 'fancy' })] });
        expect(html).toContain('No agents in Tynn.ai.');
        expect(html).toContain('data-add-agent="tynn"');
        expect(html).not.toContain('data-home-agent=');
        expect((render({ view: 'home' }).match(/data-add-agent=/g) ?? []).length).toBe(0);
    });

    it('home keeps the one file panel beside the rail when ?panel=files, and the bring-back bar when it is popped out', () => {
        const inline = render({ view: 'home', files: NO_FILES, panel: 'files' });
        expect(inline).toContain('data-files-panel="tynn"');
        expect(inline).toContain('data-workspace-home="tynn"');
        const popped = render({ view: 'home', files: NO_FILES, panel: 'files', filesPopped: true, onBringBackFiles: () => {} });
        expect(popped).toContain('data-files-popped="tynn"');
        expect(popped).not.toContain('data-files-panel="tynn"');
        // No panel asked for: the rail alone, no tree.
        expect(render({ view: 'home', files: NO_FILES, panel: null })).not.toContain('data-files-panel="tynn"');
    });
});

describe('WorkspaceHome — the rail itself', () => {
    const files = { files: [], activity: [], unreported: ['notes.md'], changed: [{ who: 'you', files: ['src/a.ts'] }, { who: 'kai', files: ['src/c.ts'] }, { who: '?', files: ['notes.md'] }] };
    const home = (f: typeof files | null) => renderToStaticMarkup(<WorkspaceHome name="Tynn.ai" view={workspaceHome(rows, 'tynn', f)} onOpenAgent={() => {}} onAddAgent={() => {}} />);

    it('CHANGES THIS SESSION: one row per file naming who — you, the agent, or "on disk · not attributed" — and no faked time or ±', () => {
        const html = home(files);
        expect(html).toContain('data-home-changes');
        expect((html.match(/data-home-change="/g) ?? []).length).toBe(3);
        expect(html).toContain('data-change-who="you"');
        expect(html).toContain('data-change-who="kai"');
        expect(html).toContain('on disk · not attributed');
        // No `+n −m` and no age anywhere: the host reports neither (§4.3 — never fake line counts).
        expect(html).not.toMatch(/[+−]\d/);
        expect(html).not.toMatch(/\d+[ms] ago|\b\d+m\b/);
    });

    it('the section is ABSENT when nothing changed — not an empty list, not a dash', () => {
        const html = home(null);
        expect(html).not.toContain('data-home-changes');
        expect(html).not.toMatch(/[—–]/);
        // POSITIVE CONTROL: the agents are still there.
        expect((html.match(/data-home-agent="/g) ?? []).length).toBe(2);
    });
});
