import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NOT_DRAWN, sectionOf, sectionFromRoute, type SectionId } from '../src/core/settings-nav.js';
import { SETTINGS } from '../src/core/settings.js';

/**
 * WORKSTATION SETTINGS — GENIE 1'S SIDEBAR (the owner, 2026-10-19: "the whole workstation settings view is stupid, ugly
 * hard to use and not even remotely correct"; plan .ai/plans/genie-2-settings-redesign.md, approved FTQ q_3e5257af).
 *
 * The navigation model, pure (as v1's renderer/lib/settings-nav.ts): grouped sections, one page each; EVERY setting has
 * exactly one place or is deliberately not drawn — internal bookkeeping and one workspace's own layout.
 */

const SECTIONS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

describe('the sidebar', () => {
    it('Genie, Accounts, Agents, Network, System — each section once', () => {
        expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Genie', 'Accounts', 'Agents', 'Network', 'System']);
        expect(SECTIONS).toEqual(['general', 'notifications', 'keyboard', 'appearance', 'tynn', 'github', 'providers', 'workspace-defaults', 'prompts', 'agent-mcp', 'plugins', 'remote', 'terminals', 'toolchain']);
        expect(new Set(SECTIONS).size).toBe(SECTIONS.length);
        for (const g of NAV_GROUPS) for (const i of g.items) expect(i.label.trim(), i.id).not.toBe('');
    });
});

describe('every setting has one place, or is deliberately not drawn', () => {
    it('each key → exactly one section, or NOT_DRAWN (COUNTED: none left over)', () => {
        const homeless = SETTINGS.filter((s) => sectionOf(s.key) === null && !NOT_DRAWN.includes(s.key)).map((s) => s.key);
        expect(homeless).toEqual([]);
        for (const s of SETTINGS) if (sectionOf(s.key) !== null) expect(SECTIONS, s.key).toContain(sectionOf(s.key));
    });

    it('not drawn: bookkeeping, one workspace’s own layout, and the remote-access switch (drawn by Remote access itself, Tynn #820)', () => {
        expect([...NOT_DRAWN].sort()).toEqual(['panel_layout', 'panel_splits', 'remote_access', 'tray_notice_shown', 'whats_new_seen_version', 'workspace_tabs']);
        for (const k of NOT_DRAWN) expect(sectionOf(k), k).toBeNull();
    });

    it('GitHub is not a setting at all: the two hand-ticked flags are gone (beta.33 item 25; the owner: "functional not some dumb list")', () => {
        // GitHub's status is read from GitHub by the account (main/github-account.ts); nothing a person ticks stands for it.
        expect(SETTINGS.filter((s) => s.key.startsWith('github_')).map((s) => s.key)).toEqual([]);
    });

    it('where things went', () => {
        const at: Record<string, SectionId> = {
            launch_at_login: 'general', do_not_disturb: 'general', update_channel: 'general', start_minimized: 'general',
            notification_sounds: 'notifications', sound_question: 'notifications',
            command_window_hotkey: 'keyboard', theme: 'appearance', sidebar_width: 'appearance',
            default_agent: 'workspace-defaults', approval_gates: 'workspace-defaults', agent_cap: 'workspace-defaults',
            saved_prompts: 'prompts', mcp_sync_claude: 'agent-mcp', mcp_sync_hooks: 'agent-mcp', developer_mode: 'plugins',
            track_cwd: 'terminals', detached_terminals: 'terminals',
        };
        for (const [key, section] of Object.entries(at)) expect(sectionOf(key), key).toBe(section);
    });
});

describe('routes', () => {
    it('genie://settings/<section>; the old groups and sub-routes land where their settings went; nothing → General', () => {
        expect(sectionFromRoute('remote')).toBe('remote');
        expect(sectionFromRoute('github')).toBe('github');
        expect(sectionFromRoute('tynn')).toBe('tynn');
        expect(sectionFromRoute('mcp')).toBe('agent-mcp');
        expect(sectionFromRoute('updates')).toBe('general');
        expect(sectionFromRoute('agents')).toBe('workspace-defaults');
        expect(sectionFromRoute('workstation')).toBe('agent-mcp');
        expect(sectionFromRoute(null)).toBe('general');
        expect(sectionFromRoute('nonsense')).toBe('general');
    });
});
