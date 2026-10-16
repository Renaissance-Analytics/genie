import { describe, expect, it } from 'vitest';
import { SETTINGS, carryOverV1, onboardingPlan, searchSettings, settingGroups, type SettingDef } from '../src/core/settings.js';

/**
 * SETTINGS AND ONBOARDING (§6.9) — the pure half. Settings live in FOUR groups with search; every
 * setting declares its scope (the §6.8 three-way split is derived from it). v1 settings that still
 * exist carry over by an explicit mapping; ones that do not are reported, never silently dropped.
 * Onboarding is TWO steps — pick a folder, meet an agent; everything else is a line with a route
 * to fix it, never a gate.
 */

describe('the registry', () => {
    it('has exactly four groups, every setting in one of them, every key unique, every scope declared', () => {
        expect(settingGroups()).toEqual(['general', 'agents', 'workstation', 'appearance']);
        const keys = SETTINGS.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const s of SETTINGS) {
            expect(settingGroups()).toContain(s.group);
            expect(['device', 'workspace', 'host']).toContain(s.scope);
            expect(s.label.length).toBeGreaterThan(0);
        }
    });

    it('carries the settings the spec names: restore agents on launch (default OFF), update channel, theme, default agent, DND reply, notification sounds', () => {
        const byKey = Object.fromEntries(SETTINGS.map((s) => [s.key, s])) as Record<string, SettingDef>;
        expect(byKey.restore_agents_on_launch).toMatchObject({ type: 'boolean', default: false, scope: 'host', group: 'agents' });
        expect(byKey.update_channel).toMatchObject({ type: 'enum', options: ['stable', 'dev'], default: 'dev', scope: 'host', group: 'general' });
        expect(byKey.theme).toMatchObject({ type: 'enum', options: ['dark', 'light', 'system'], default: 'system', scope: 'device', group: 'appearance' });
        expect(byKey.default_agent).toMatchObject({ scope: 'workspace', group: 'agents' });
        expect(byKey.dnd_reply).toMatchObject({ type: 'string', group: 'general' });
        expect(byKey.notification_sounds).toMatchObject({ type: 'boolean', default: true, scope: 'device', group: 'general' });
    });

    it('carries the tray-resident pair, both OFF by default, and the one-time notice marker hidden from the surface', () => {
        const byKey = Object.fromEntries(SETTINGS.map((s) => [s.key, s])) as Record<string, SettingDef>;
        expect(byKey.start_minimized).toMatchObject({ type: 'boolean', default: false, scope: 'host', group: 'general', label: 'Start minimized to tray' });
        expect(byKey.launch_at_login).toMatchObject({ type: 'boolean', default: false, scope: 'host', group: 'general', label: 'Launch at sign-in' });
        expect(byKey.tray_notice_shown).toMatchObject({ type: 'boolean', default: false, hidden: true });
        expect(searchSettings('').map((s) => s.key)).toEqual(expect.arrayContaining(['start_minimized', 'launch_at_login']));
        expect(searchSettings('').map((s) => s.key)).not.toContain('tray_notice_shown');
    });
});

describe('search', () => {
    it('matches label, key and description, case-insensitively, and returns the group with each hit', () => {
        const hits = searchSettings('theme');
        expect(hits.map((h) => h.key)).toContain('theme');
        expect(hits[0]!.group).toBe('appearance');
        expect(searchSettings('RESTORE').map((h) => h.key)).toEqual(['restore_agents_on_launch']);
        expect(searchSettings('zzz-nothing')).toEqual([]);
    });
});

describe('carrying v1 settings over', () => {
    it('maps the v1 keys that still exist to their genie2 keys and values, and REPORTS the ones that do not', () => {
        const v1 = {
            theme: 'light',
            restore_agents_on_launch: 'true',
            update_channel: 'beta', // v1's name for the dev channel — migrated, not dropped
            agent_command: 'claude --dangerously-skip-permissions',
            track_cwd: 'on',
        };
        const r = carryOverV1(v1);
        expect(r.applied).toEqual({ theme: 'light', restore_agents_on_launch: true, update_channel: 'dev', track_cwd: true });
        // COUNTED: the one field that must NOT come over — the agent launch line — is named, not lost silently.
        expect(r.dropped).toEqual([{ key: 'agent_command', reason: 'agents are sessions in Genie 2; there is no launch line to carry' }]);
    });

    it('a value that does not fit the setting’s type is dropped with the reason, not coerced into a wrong default', () => {
        const r = carryOverV1({ theme: 'sepia', restore_agents_on_launch: 'maybe' });
        expect(r.applied).toEqual({});
        expect(r.dropped.map((d) => d.key).sort()).toEqual(['restore_agents_on_launch', 'theme']);
        expect(r.dropped.find((d) => d.key === 'theme')!.reason).toMatch(/sepia/);
    });

    it('Genie 1’s start_minimized (stored as on / off) carries over; it was REPORTED as dropped before', () => {
        expect(carryOverV1({ start_minimized: 'on' })).toEqual({ applied: { start_minimized: true }, dropped: [] });
        expect(carryOverV1({ start_minimized: 'off' })).toEqual({ applied: { start_minimized: false }, dropped: [] });
    });

    it('nothing to carry is an empty result, not an error', () => {
        expect(carryOverV1({})).toEqual({ applied: {}, dropped: [] });
    });
});

describe('onboarding — two steps, two decisions', () => {
    it('with nothing set up, the steps are pick a folder then meet an agent; everything else is a LINE with a route, never a gate', () => {
        const plan = onboardingPlan({ workspaces: 0, agents: 0, providers: [], githubConnected: false, tynnSignedIn: false });
        expect(plan.steps.map((s) => s.id)).toEqual(['pick-folder', 'meet-agent']);
        expect(plan.steps.every((s) => s.required)).toBe(true);
        expect(plan.lines.map((l) => [l.id, l.route])).toEqual([
            ['no-provider', 'genie://settings/agents'],
            ['github', 'genie://settings/github'],
            ['tynn', 'genie://settings/tynn'],
        ]);
        expect(plan.done).toBe(false);
    });

    it('a folder picked and an agent met is DONE — even with GitHub and Tynn not connected, which stay lines', () => {
        const plan = onboardingPlan({ workspaces: 1, agents: 1, providers: ['claude'], githubConnected: false, tynnSignedIn: false });
        expect(plan.steps).toEqual([]);
        expect(plan.done).toBe(true);
        expect(plan.lines.map((l) => l.id)).toEqual(['github', 'tynn']);
    });

    it('Genie is fully usable signed out: a signed-in Tynn removes the line and adds nothing', () => {
        const plan = onboardingPlan({ workspaces: 1, agents: 1, providers: ['claude'], githubConnected: true, tynnSignedIn: true });
        expect(plan.lines).toEqual([]);
    });
});

describe('onboarding — what Genie cannot see yet is NOT a line', () => {
    it('providers / GitHub / Tynn unknown (null) draw no line — "we have not looked" is not "it is missing"', () => {
        const plan = onboardingPlan({ workspaces: 0, agents: 0, providers: null, githubConnected: null, tynnSignedIn: null });
        expect(plan.steps.map((s) => s.id)).toEqual(['pick-folder', 'meet-agent']);
        expect(plan.lines).toEqual([]);
        // POSITIVE CONTROL: the same plan with measured absences draws all three lines.
        expect(onboardingPlan({ workspaces: 0, agents: 0, providers: [], githubConnected: false, tynnSignedIn: false }).lines).toHaveLength(3);
    });
});
