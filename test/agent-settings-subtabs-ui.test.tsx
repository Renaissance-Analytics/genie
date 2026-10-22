import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { SettingsSection } from '../src/core/agent-settings-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE SETTINGS TAB, RENDERED IN SUB-TABS (agent-management parity item 3; the owner, 2026-10-21: "the whole agent
 * settings UX is very clunky with a lot of scrolling and wasted space"). The pure layout is `agent-settings-view.ts`;
 * this proves the view draws it: one sub-tab's controls at a time, provider and model first, Unmount / Delete at the
 * foot of General, compact permission rows, IssueWatch in three groups, the budget as a strip.
 */
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
    model: null, onSetModel: () => {}, models: { ok: true, source: 'provider', current: null, models: [{ modelId: 'opus', name: 'Opus', isDefault: true }, { modelId: 'fable', name: 'Fable' }] },
    onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
};
function render(section?: SettingsSection, over: { agent?: Partial<typeof AGENT>; ops?: Record<string, unknown> | null } = {}): string {
    const ops = over.ops === null ? undefined : { ...OPS, ...(over.ops ?? {}) };
    return renderToStaticMarkup(
        <AgentView agent={{ ...AGENT, ...(over.agent ?? {}) }} session={session} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={2} cost={0.5}
            onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={ops as never} personaText="You are kai." onStop={() => {}} settingsSection={section} />,
    );
}
const panel = (html: string) => html.slice(html.indexOf('data-agent-settings'));
const tabsIn = (html: string) => [...html.matchAll(/data-settings-tab="([a-z]+)"/g)].map((m) => m[1]);

describe('the sub-tab strip', () => {
    it('General, Permissions, IssueWatch, Persona, Skills — General open when none is asked for', () => {
        const html = render();
        expect(tabsIn(html)).toEqual(['general', 'permissions', 'issuewatch', 'persona', 'skills']);
        expect(html).toMatch(/data-settings-tab="general"[^>]*aria-selected="true"/);
        expect(panel(html)).toContain('data-settings-section="general"');
    });

    it('ONE sub-tab at a time: General carries no Permissions, IssueWatch, Persona or Skills controls', () => {
        const html = panel(render('general'));
        for (const absent of ['data-access-scope', 'data-auto-approve', 'data-issue-watch', 'data-persona-text', 'data-rail-commands', 'data-permissions=']) {
            expect(html).not.toContain(absent);
        }
        // CONTROL: the same render on Permissions has them — the tab, not a missing setter, hid them.
        expect(panel(render('permissions'))).toContain('data-access-scope');
    });

    it('a codex agent: no Tools control on Permissions; an observed agent has no Settings at all', () => {
        expect(panel(render('permissions', { agent: { provider: 'codex' } }))).not.toContain('data-permissions=');
        expect(panel(render('permissions'))).toContain('data-permissions="all"');
        expect(render(undefined, { agent: { fidelity: 'observed' as never } })).not.toContain('data-settings-tab');
    });
});

describe('General', () => {
    it('Provider and Model side by side at the TOP, before the mode', () => {
        const html = panel(render('general'));
        const provider = html.indexOf('data-agent-provider');
        const model = html.indexOf('data-model-select');
        const mode = html.indexOf('data-mode=');
        expect(provider).toBeGreaterThan(-1);
        expect(model).toBeGreaterThan(provider);
        expect(mode).toBeGreaterThan(model);
        expect(html).toMatch(/data-settings-row="provider-model"[\s\S]*?data-agent-provider[\s\S]*?data-model-select/);
        // Model names only from the provider's list.
        expect([...html.matchAll(/data-model-select[\s\S]*?<\/select>/g)][0]![0]).toMatch(/value="opus"[\s\S]*value="fable"/);
    });

    it('the run controls are the operations menu’s own buttons', () => {
        const html = panel(render('general'));
        for (const id of ['stop-agent', 'restart-graceful', 'restart-fresh', 'diagnose']) expect(html).toContain(`data-run-action="${id}"`);
    });

    it('a separated Remove area LAST: Unmount from Genie… (files stay) and Delete… (files removed), the menu’s ids', () => {
        const html = panel(render('general'));
        const remove = html.slice(html.indexOf('data-settings-remove'));
        expect(html.indexOf('data-settings-remove')).toBeGreaterThan(html.indexOf('data-mode='));
        expect(remove).toMatch(/data-remove-action="delete-unmount"[^>]*>[\s\S]*?Unmount from Genie…/);
        expect(remove).toMatch(/data-remove-action="delete-delete"[^>]*>[\s\S]*?Delete…/);
        expect(remove).toContain('keeps every .agents/* file');
        expect(remove).toContain('removes the persona folder too');
    });
});

describe('Remove from workspace and the provider row (agent-management parity item 1)', () => {
    it('Remove’s buttons open the SAME confirm card as the menu, and that card asks for a handoff from a running agent', () => {
        const html = render('general', { ops: { deletePreview: { outcome: 'unmount', removes: [], keeps: [], external: [] } } });
        expect(html).toContain('data-settings-remove');
        expect(html).toContain('data-delete-confirm="unmount"');
        expect(html).toMatch(/<input type="checkbox" name="handoff" checked=""/);
    });

    it('the provider row says a switch starts a NEW conversation — one line, the whole of it on hover', () => {
        const provider = panel(render('general')).match(/data-rail="provider"[\s\S]*?<\/section>/)?.[0] ?? '';
        expect(provider).toMatch(/title="Its name, inbox and history stay; it starts a new conversation on the new provider\."/);
        expect(provider).not.toMatch(/next turn runs on the new provider/);
    });
});

describe('Permissions — compact rows', () => {
    it('each control is one row with ONE short help line, not two-line paragraphs', () => {
        const html = panel(render('permissions'));
        const rows = [...html.matchAll(/data-settings-row="([a-z-]+)"/g)].map((m) => m[1]);
        expect(rows).toEqual(['tools', 'access', 'autonomous', 'manage-tabs', 'drive-pages']);
        // The long second paragraphs are a tooltip now, not text under the switch.
        expect(html).not.toMatch(/<span class="mt-0.5 block/);
        expect(html).toMatch(/title="Each one is recorded\./);
    });
});

describe('IssueWatch — grouped', () => {
    it('delivery first, then Opened / Changed / Activity in a grid, with the defaults ticked', () => {
        const html = panel(render('issuewatch'));
        expect(html.indexOf('data-issue-watch-delivery')).toBeLessThan(html.indexOf('data-iw-group'));
        expect([...html.matchAll(/data-iw-group="([A-Za-z]+)"/g)].map((m) => m[1])).toEqual(['Opened', 'Changed', 'Activity']);
        expect(html).toMatch(/data-issue-watch-kind="issue.new"[^>]*checked=""/);
        expect(html).not.toMatch(/data-issue-watch-kind="comment"[^>]*checked=""/);
    });
});

describe('Persona and Skills — the existing views, each on its own sub-tab', () => {
    it('Persona shows the read-only file; Skills the CLI’s commands', () => {
        expect(panel(render('persona'))).toContain('data-persona-text');
        expect(panel(render('skills'))).toContain('data-command="review"');
    });
});

describe('Budget is a strip, on every sub-tab', () => {
    it('context, cost and turns in one strip above the sub-tab body', () => {
        for (const s of ['general', 'permissions', 'persona'] as const) {
            const html = panel(render(s));
            expect(html).toMatch(/data-rail="budget"[^>]*data-settings-strip=""/);
            expect(html.indexOf('data-rail="budget"')).toBeLessThan(html.indexOf('data-settings-section'));
        }
    });

    it('the half-empty two-column layout is gone', () => {
        expect(panel(render('general'))).not.toContain('xl:grid-cols-2');
    });
});

describe('a result beside the control that caused it', () => {
    it('without a touch (a server render), the outcome stays in the single line under the header', () => {
        const html = render('general', { ops: { lastOutcome: 'Couldn’t set the model' } });
        expect(html).toContain('data-ops-outcome');
        expect(html).not.toContain('data-control-outcome');
    });
});
