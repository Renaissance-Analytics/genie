import { describe, expect, it } from 'vitest';
import { IW_EVENT_KINDS } from '../src/core/issue-watch.js';
import {
    controlOutcome, issueWatchGroups, runControls, settingsSectionShown, settingsSections, type SettingsFacts,
} from '../src/core/agent-settings-view.js';

/**
 * THE AGENT SETTINGS TAB, IN SUB-TABS (agent-management parity item 3). The owner, 2026-10-21, on the one long Settings
 * page: "the whole agent settings UX is very clunky with a lot of scrolling and wasted space"; and "I need to be able to
 * change provider as well as model ... purge an agent ... or detach it". Genie 1's AgentManager had short tabs of
 * labelled fields; Genie 2's settings follow it: General, Permissions, IssueWatch, Persona, Skills.
 *
 * Which tab holds which control, per provider and fidelity, is decided here so it is proven without rendering.
 */
const ALL: SettingsFacts = {
    fidelity: 'declared', provider: 'claude', ops: true, model: true, tools: true, autonomous: true, manageTabs: true,
    drivePages: true, issueWatch: true, persona: true, skills: true,
};
const ids = (f: SettingsFacts) => settingsSections(f).map((s) => s.id);
const controlsOf = (f: SettingsFacts, id: string) => settingsSections(f).find((s) => s.id === id)?.controls ?? null;

describe('settingsSections — the sub-tabs and what each holds', () => {
    it('a declared Claude agent with everything: General, Permissions, IssueWatch, Persona, Skills — in that order', () => {
        expect(ids(ALL)).toEqual(['general', 'permissions', 'issuewatch', 'persona', 'skills']);
        expect(settingsSections(ALL).map((s) => s.label)).toEqual(['General', 'Permissions', 'IssueWatch', 'Persona', 'Skills']);
    });

    it('General leads with PROVIDER then MODEL (the owner’s first ask), then mode and run controls; Remove is LAST', () => {
        expect(controlsOf(ALL, 'general')).toEqual(['provider', 'model', 'mode', 'run', 'remove']);
    });

    it('Permissions: tools, who may message, autonomous, manage tabs, drive pages', () => {
        expect(controlsOf(ALL, 'permissions')).toEqual(['tools', 'access', 'autonomous', 'manage-tabs', 'drive-pages']);
    });

    it('codex has NO Tools setting (its permissions are asked in the chat); the rest of Permissions stays', () => {
        const codex = { ...ALL, provider: 'codex' };
        expect(controlsOf(codex, 'permissions')).toEqual(['access', 'autonomous', 'manage-tabs', 'drive-pages']);
        // CONTROL: the same facts on claude carry it — the provider, not the setter, removed it.
        expect(controlsOf(ALL, 'permissions')).toContain('tools');
    });

    it('a window that cannot set a control does not draw it (absent setter = absent control)', () => {
        const f = { ...ALL, model: false, tools: false, autonomous: false, manageTabs: false, drivePages: false };
        expect(controlsOf(f, 'general')).toEqual(['provider', 'mode', 'run', 'remove']);
        expect(controlsOf(f, 'permissions')).toEqual(['access']);
    });

    it('no IssueWatch setter → no IssueWatch tab; no persona path → no Persona tab; nothing reported → no Skills tab', () => {
        expect(ids({ ...ALL, issueWatch: false, persona: false, skills: false })).toEqual(['general', 'permissions']);
    });

    it('a window without agent operations keeps only what it can SHOW: Persona and Skills', () => {
        expect(ids({ ...ALL, ops: false })).toEqual(['persona', 'skills']);
    });

    it('an OBSERVED agent gets no operations and no settings at all', () => {
        expect(ids({ ...ALL, fidelity: 'observed' })).toEqual([]);
    });
});

describe('settingsSectionShown — the tab asked for, or the first one there is', () => {
    const sections = settingsSections(ALL);
    it('shows the one asked for when the agent has it', () => {
        expect(settingsSectionShown(sections, 'issuewatch')).toBe('issuewatch');
    });
    it('falls back to the first tab when the asked one is absent (a codex agent asked for nothing it lacks still lands)', () => {
        expect(settingsSectionShown(settingsSections({ ...ALL, issueWatch: false }), 'issuewatch')).toBe('general');
        expect(settingsSectionShown(settingsSections({ ...ALL, ops: false }), 'general')).toBe('persona');
        expect(settingsSectionShown([], 'general')).toBeNull();
    });
});

describe('issueWatchGroups — the thirteen boxes in three short groups', () => {
    it('Opened / Changed / Activity, every kind exactly once, in IssueWatch’s own order inside a group', () => {
        const groups = issueWatchGroups();
        expect(groups.map((g) => g.label)).toEqual(['Opened', 'Changed', 'Activity']);
        expect(groups[0]!.kinds.map((k) => k.kind)).toEqual(['issue.new', 'pr.new', 'security.new', 'feedback.new']);
        expect(groups[1]!.kinds.map((k) => k.kind)).toEqual(['issue.updated', 'pr.updated', 'security.updated', 'closed']);
        expect(groups[2]!.kinds.map((k) => k.kind)).toEqual(['comment', 'review', 'push', 'ci.failed', 'ci.passed']);
        const all = groups.flatMap((g) => g.kinds.map((k) => k.kind));
        expect([...all].sort()).toEqual(IW_EVENT_KINDS.map((k) => k.kind).sort());
    });
});

describe('runControls — the operations menu’s run items, on General', () => {
    it('restart (both), diagnose — and Stop agent while it runs; never switch or delete (those have their own controls)', () => {
        expect(runControls({ provider: 'claude', fidelity: 'declared' }, false).map((i) => i.id)).toEqual(['restart-graceful', 'restart-fresh', 'diagnose']);
        expect(runControls({ provider: 'claude', fidelity: 'declared' }, true).map((i) => i.id)).toEqual(['stop-agent', 'restart-graceful', 'restart-fresh', 'diagnose']);
        // The labels are the menu's own — no new names.
        expect(runControls({ provider: 'claude', fidelity: 'declared' }, false)[0]!.label).toBe('Restart gracefully');
    });
    it('an observed agent: none', () => {
        expect(runControls({ provider: 'claude', fidelity: 'observed' }, true)).toEqual([]);
    });
});

describe('controlOutcome — a result shown beside the control that caused it', () => {
    it('after a control is touched, a NEW outcome belongs to it', () => {
        expect(controlOutcome({ control: 'model', before: null }, 'Couldn’t set the model')).toEqual({ control: 'model', text: 'Couldn’t set the model' });
        expect(controlOutcome({ control: 'tools', before: 'old' }, 'new')).toEqual({ control: 'tools', text: 'new' });
    });
    it('the outcome that was already there when it was touched is not its result', () => {
        expect(controlOutcome({ control: 'model', before: 'restarted gracefully' }, 'restarted gracefully')).toBeNull();
    });
    it('nothing touched, or no outcome: nothing beside any control', () => {
        expect(controlOutcome(null, 'something')).toBeNull();
        expect(controlOutcome({ control: 'model', before: null }, null)).toBeNull();
    });
});
