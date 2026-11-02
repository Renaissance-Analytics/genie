import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { SETTINGS } from '../src/core/settings.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { MobileWorkspaces } from '../src/renderer/components/MobileShell.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { control } from './helpers/control-markup.js';

/**
 * MENUS ARE MENUS, TABS ARE TABS, NOT BUTTONS (the owner, 2026-11-01, on Genie 2.0.0-beta.55's Settings nav with every
 * item centred: "this issue is everywhere we had menus … those should not be buttons, it's a menu"). The real-buttons
 * sweep made menus and tabs into react-fancy Buttons; a Button centres its label and keeps a focus ring after a mouse
 * click. Buttons are for actions, links are links, and menus and tabs are react-fancy's navigation components:
 *   - the Settings nav is a react-fancy Sidebar (embedded) inside <nav aria-label="Settings">: items left-aligned, the page
 *     on screen marked aria-current="page", a focus ring for keyboard focus only;
 *   - the workspace's and the agent's view tabs (and the agent's settings sub-tabs) are react-fancy Tabs: role="tab" in a
 *     role="tablist", the one on screen aria-selected="true";
 *   - the two segmented filters (Dashboard By workspace | By status; Files All | Changed N) are a react-fancy MultiSwitch:
 *     a radio group, the chosen one aria-checked="true";
 *   - the mobile workspace chips are Tabs in the pills variant.
 * Each surface is checked against react-fancy's OWN markers (data-react-fancy-sidebar-item, -tabs-tab, -multi-switch),
 * and against NOT being a react-fancy Button.
 */

const BUTTON = 'data-react-fancy-button=""';
/** A focus ring that shows on a mouse click (`focus:ring…`), as opposed to `focus-visible:` (keyboard focus only). */
const MOUSE_FOCUS_RING = /\sfocus:(ring|outline)/;
/** Every radio in the markup: [its text, aria-checked]. */
const radios = (html: string) => [...html.matchAll(/<button\b[^>]*role="radio"[^>]*aria-checked="(true|false)"[^>]*>([^<]*)</g)].map((m) => [m[2], m[1]]);

describe('the Settings nav is a react-fancy Sidebar, not Buttons', () => {
    const values = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
    const html = renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} section="remote" workspaces={[]} />);

    it('is an embedded Sidebar whose own <nav aria-label="Settings"> (react-fancy 6.1 `navLabel`) holds the items', () => {
        expect(html).toMatch(/<aside[^>]*data-react-fancy-sidebar=""[^>]*data-embedded="true"[^>]*>\s*<nav data-react-fancy-sidebar-nav="" aria-label="Settings"/);
        // ONE Settings landmark: the search box sits above the Sidebar, outside it, and is not a second nav.
        expect(html.match(/aria-label="Settings"/g)).toHaveLength(1);
        const nav = html.slice(html.indexOf('data-react-fancy-sidebar-nav'));
        expect(nav.indexOf('data-settings-nav="general"')).toBeLessThan(nav.indexOf('</nav>'));
    });

    it('each section is a Sidebar item; the page on screen (and only it) is aria-current="page"', () => {
        const remote = control(html, 'data-settings-nav="remote"')!;
        expect(remote.open).toContain('data-react-fancy-sidebar-item=""');
        expect(remote.open).not.toContain(BUTTON);
        expect(remote.open).toContain('aria-current="page"');
        expect(remote.open).toContain('data-nav-target="genie://settings/remote"');
        const general = control(html, 'data-settings-nav="general"')!;
        expect(general.open).toContain('data-react-fancy-sidebar-item=""');
        expect(general.open).not.toContain('aria-current');
        const nav = html.slice(html.indexOf('data-react-fancy-sidebar-nav'), html.indexOf('</nav>', html.indexOf('data-react-fancy-sidebar-nav')));
        expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    });

    it('items are LEFT-aligned (never centred) and ring only on keyboard focus', () => {
        const general = control(html, 'data-settings-nav="general"')!;
        expect(general.open).not.toMatch(/\sjustify-center/);
        expect(general.inner).toMatch(/class="[^"]*\btext-left\b[^"]*"[^>]*>General</);
        expect(general.open).toContain('focus-visible:ring');
        expect(general.open).not.toMatch(MOUSE_FOCUS_RING);
    });
});

describe('the workspace view tabs are react-fancy Tabs', () => {
    const render = (current: Parameters<typeof WorkspaceTabs>[0]['current']) =>
        renderToStaticMarkup(
            <WorkspaceTabs designed={{ tabs: [] }} agents={[{ id: 'a1', name: 'atlas', state: 'working' }]} current={current} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} />,
        );

    it('a tablist of role="tab"; the view on screen is aria-selected="true", the rest "false"; no data-current', () => {
        const html = render({ kind: 'view', view: 'home' });
        expect(html).toContain('role="tablist"');
        const home = control(html, 'data-workspace-tab="home"')!;
        expect(home.open).toContain('data-react-fancy-tabs-tab=""');
        expect(home.open).toContain('role="tab"');
        expect(home.open).toContain('aria-selected="true"');
        expect(home.open).not.toContain(BUTTON);
        expect(control(html, 'data-workspace-tab="settings"')!.open).toContain('aria-selected="false"');
        expect(control(html, 'data-workspace-tab="agent:a1"')!.open).toContain('aria-selected="false"');
        expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
        expect(html).not.toContain('data-current');
    });

    it('on an agent’s page its agent tab is the selected one', () => {
        const html = render({ kind: 'agent', id: 'a1' });
        expect(control(html, 'data-workspace-tab="agent:a1"')!.open).toContain('aria-selected="true"');
        expect(control(html, 'data-workspace-tab="home"')!.open).toContain('aria-selected="false"');
    });

    it('the + is an ACTION, so it stays a react-fancy Button and is not a tab', () => {
        const add = control(render({ kind: 'view', view: 'home' }), 'data-workspace-tab="add"')!;
        expect(add.open).toContain(BUTTON);
        expect(add.open).not.toContain('role="tab"');
    });
});

describe('the agent view tabs and its settings sub-tabs are react-fancy Tabs', () => {
    // The fixture of test/agent-settings-subtabs-ui.test.tsx, which renders this same Settings tab.
    const session = {
        running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: 120_000, contextSize: 200_000,
        plan: null, model: null, mcpServers: ['genie'], extensions: { commands: [{ name: 'review', description: 'Review a PR' }], skills: [], plugins: [] },
    } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w', instructions: '.agents/kai/AGENT.md' };
    const OPS = {
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'automated', accessScope: 'self',
        onSetMode: () => {}, onSetAccessScope: () => {}, autoApprove: false, onSetAutoApprove: () => {}, manageTabs: false, onSetManageTabs: () => {},
        drivePages: false, onSetDrivePages: () => {}, permissions: 'all', onSetPermissions: () => {},
        issueWatch: { delivery: 'push', kinds: ['issue.new', 'pr.new', 'security.new', 'feedback.new'], chosen: false }, onSetIssueWatch: () => {},
        model: null, onSetModel: () => {}, models: { ok: true, source: 'provider', current: null, models: [{ modelId: 'opus', name: 'Opus', isDefault: true }] },
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
    };
    const html = renderToStaticMarkup(
        <AgentView agent={AGENT} session={session} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null}
            onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={OPS as never} personaText="You are kai." onStop={() => {}} />,
    );

    it('the view tabs: role="tab", the one on screen aria-selected="true"', () => {
        const settings = control(html, 'data-tab="settings"')!;
        expect(settings.open).toContain('data-react-fancy-tabs-tab=""');
        expect(settings.open).toContain('aria-selected="true"');
        expect(settings.open).not.toContain(BUTTON);
        expect(control(html, 'data-tab="stream"')!.open).toContain('aria-selected="false"');
        expect(html).not.toMatch(/data-tab="[a-z]+"[^>]*data-active=/);
    });

    it('the settings sub-tabs: General selected, the others not', () => {
        const general = control(html, 'data-settings-tab="general"')!;
        expect(general.open).toContain('data-react-fancy-tabs-tab=""');
        expect(general.open).toContain('aria-selected="true"');
        expect(general.open).not.toContain(BUTTON);
        expect(control(html, 'data-settings-tab="permissions"')!.open).toContain('aria-selected="false"');
    });
});

describe('the agent’s breadcrumb is react-fancy Breadcrumbs', () => {
    const session = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as unknown as LiveSession;
    const html = renderToStaticMarkup(
        <AgentView agent={{ id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' }} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null}
            onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} />,
    );

    it('a <nav aria-label="Breadcrumb">: the workspace is a crumb that leads back, the agent is the current page', () => {
        expect(html).toMatch(/<nav data-react-fancy-breadcrumbs="" aria-label="Breadcrumb"/);
        const crumb = control(html, 'data-crumb="tynn"')!;
        expect(crumb.open).toContain('data-react-fancy-breadcrumbs-item=""');
        expect(crumb.open).not.toContain(BUTTON);
        expect(crumb.open).toContain('data-nav="genie://workspace/tynn"');
        expect(crumb.text).toBe('Tynn.ai');
        expect(html).toMatch(/<span(?=[^>]*data-react-fancy-breadcrumbs-item="")(?=[^>]*aria-current="page")[^>]*data-agent-name=""[^>]*>atlas<\/span>/);
    });

    it('the slash is the Breadcrumbs separator (decoration, hidden from a screen reader), not part of the crumb’s name', () => {
        const nav = html.slice(html.indexOf('data-react-fancy-breadcrumbs=""'), html.indexOf('</nav>', html.indexOf('data-react-fancy-breadcrumbs=""')));
        expect(nav).toMatch(/<span aria-hidden="true"><span[^>]*>\/<\/span><\/span>/);
    });
});

describe('the segmented filters are a react-fancy MultiSwitch (a radio group)', () => {
    it('Dashboard: By workspace | By status, the grouping in use aria-checked="true"', () => {
        const render = (group: 'workspace' | 'status') =>
            renderToStaticMarkup(<Dashboard rows={[]} workspaces={[{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} group={group} onGroup={() => {}} />);
        const html = render('workspace');
        expect(html).toMatch(/data-react-fancy-multi-switch=""[^>]*role="radiogroup"|role="radiogroup"[^>]*data-react-fancy-multi-switch=""/);
        expect(html).toMatch(/<div[^>]*data-group-toggle=""[^>]*aria-label="Group the agents"/);
        expect(radios(html)).toEqual([['By workspace', 'true'], ['By status', 'false']]);
        expect(radios(render('status'))).toEqual([['By workspace', 'false'], ['By status', 'true']]);
        expect(html).not.toContain('data-current');
    });

    it('Files: All | Changed N, the filter in use aria-checked="true"; `data-changes` on the switch while there are changes', () => {
        const base: FilesPanelProps = {
            workspace: { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }, tree: [], tabs: [], open: null, pinned: false,
            state: { files: [{ path: 'src/a.ts', agents: [], count: 1, inFlight: false }], activity: [], unreported: [], changed: [{ who: 'you', files: ['src/a.ts'] }] } as never,
            onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
        };
        const html = renderToStaticMarkup(<FilesPanel {...base} filter="changed" onFilter={() => {}} />);
        expect(html).toMatch(/<div[^>]*data-files-filter=""[^>]*role="radiogroup"/);
        expect(html).toMatch(/<div[^>]*data-files-filter=""[^>]*data-changes=""/);
        expect(radios(html)).toEqual([['All', 'false'], ['Changed 1', 'true']]);
        expect(html).not.toContain('data-current');
    });
});

describe('the mobile workspace chips are react-fancy Tabs (pills)', () => {
    it('All, then each workspace, as tabs; the selected one aria-selected="true"', () => {
        const html = renderToStaticMarkup(<MobileWorkspaces workspaces={[{ id: 'tynn', path: '/w/tynn', name: 'Tynn' }]} agents={[]} items={[]} selected="tynn" onSelect={() => {}} />);
        expect(html).toMatch(/<nav[^>]*aria-label="Workspaces"[\s\S]*role="tablist"/);
        const tynn = control(html, 'data-mobile-ws="tynn"')!;
        expect(tynn.open).toContain('data-react-fancy-tabs-tab=""');
        expect(tynn.open).toContain('aria-selected="true"');
        expect(tynn.open).not.toContain(BUTTON);
        expect(control(html, 'data-mobile-ws="all"')!.open).toContain('aria-selected="false"');
        expect(html).not.toContain('data-selected');
    });
});
