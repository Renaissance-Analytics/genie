import { describe, expect, it } from 'vitest';
import {
    NAV_GROUPS,
    HOST_SOURCED_SETTINGS_KEYS,
    HOST_SOURCED_SECTIONS,
    RUNTIME_OWNED_SETTINGS_KEYS,
    defaultSection,
    filterNavGroups,
    isHostSourcedSection,
    isHostSourcedSettingKey,
    isRuntimeOwnedSettingKey,
    isSectionVisible,
    withoutRuntimeOwnedSettings,
    type SectionId,
} from '../settings-nav';
import type { Settings } from '../genie';

/**
 * The remote-window Settings split: in a remote/host window Settings shows the
 * DEVICE-LOCAL Customization PLUS the HOST-SOURCED workspace/agent sections (Tools,
 * Agent MCP); every host-machine / connection section is hidden. A local window is
 * unchanged. React rendering is manual/e2e-verify (Node test env has no DOM) — this
 * covers the pure gating + the bucket-2 key allow-list the page + bridge render from.
 */

const allIds = (): SectionId[] => NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

describe('local (unrestricted) Settings', () => {
    it('shows the full nav unchanged', () => {
        expect(filterNavGroups(NAV_GROUPS, false)).toBe(NAV_GROUPS);
    });
    it('shows every section', () => {
        for (const id of allIds()) expect(isSectionVisible(id, false)).toBe(true);
    });
    it('defaults to General', () => {
        expect(defaultSection(false)).toBe('general');
    });
});

describe('remote (restricted) Settings', () => {
    it('nav keeps Customization + the host-sourced sections (empty groups dropped)', () => {
        const groups = filterNavGroups(NAV_GROUPS, true);
        const items = groups.flatMap((g) => g.items.map((i) => i.id));
        // Order preserved from NAV_GROUPS: Tools + Customization (Workspace group),
        // then Agent MCP (Agents & network group).
        expect(items).toEqual(['tools', 'customization', 'agent-mcp']);
        expect(groups.map((g) => g.label)).toEqual(['Workspace', 'Agents & network']);
        // The "System" group (Updates) has no visible item → dropped.
    });

    it('only Customization + Tools + Agent MCP render; everything else is hidden', () => {
        for (const id of ['customization', 'tools', 'agent-mcp'] as SectionId[]) {
            expect(isSectionVisible(id, true)).toBe(true);
        }
        for (const id of [
            'general',
            'workspaces',
            'mobile',
            'sites',
            'connections',
            'devices',
            'updates',
        ] as SectionId[]) {
            expect(isSectionVisible(id, true)).toBe(false);
        }
    });

    it('defaults to the first surviving section (Tools)', () => {
        expect(defaultSection(true)).toBe('tools');
    });
});

describe('host-sourced (bucket 2) classification', () => {
    it('Tools + Agent MCP are host-sourced; Customization is device-local', () => {
        expect(isHostSourcedSection('tools')).toBe(true);
        expect(isHostSourcedSection('agent-mcp')).toBe(true);
        expect(isHostSourcedSection('customization')).toBe(false);
        expect([...HOST_SOURCED_SECTIONS].sort()).toEqual(['agent-mcp', 'tools']);
    });

    it('the host-sourced key allow-list is exactly the workspace/agent-env keys', () => {
        expect([...HOST_SOURCED_SETTINGS_KEYS].sort()).toEqual(
            [
                'ai_system',
                'cli_tools_in_terminals',
                'mcp_port',
                'mcp_sync_agents',
                'mcp_sync_claude',
                'mcp_sync_codex',
                'mcp_sync_cursor',
            ].sort(),
        );
    });

    it('classifies keys: agent-env → host, device prefs → local', () => {
        for (const k of [
            'ai_system',
            'cli_tools_in_terminals',
            'mcp_port',
            'mcp_sync_claude',
            'mcp_sync_cursor',
            'mcp_sync_codex',
            'mcp_sync_agents',
        ]) {
            expect(isHostSourcedSettingKey(k)).toBe(true);
        }
        // Device/UI prefs + host-machine-only keys are NOT host-sourced.
        for (const k of [
            'notify_sound',
            'notify_toast',
            'terminal_copy_paste',
            'max_views',
            'primary_workspace',
            'global_hotkey',
            'tynn_host',
            'remote_enabled',
            'auto_update',
        ]) {
            expect(isHostSourcedSettingKey(k)).toBe(false);
        }
    });
});

/**
 * The Settings window loads the WHOLE Settings object once and writes it back on
 * Save. The master Floor + its grid own a handful of runtime keys (panel view
 * state, grid sizes, active workspace, sidebar collapse) that they persist
 * continuously as the user works. Those MUST be stripped from the Settings save,
 * or the wholesale write reverts them to the stale open-time snapshot — reopening
 * closed panels and resetting sizes for the local AND every host window. This is
 * the root-cause guard for that clobber.
 */
describe('runtime-owned (Settings-never-writes) classification', () => {
    it('the runtime-owned key list is exactly the master/grid session keys', () => {
        expect([...RUNTIME_OWNED_SETTINGS_KEYS].sort()).toEqual(
            [
                'active_workspace',
                'collapsed_workspaces',
                'last_terminal_type',
                'layout_json',
                'view_state_json',
            ].sort(),
        );
    });

    it('classifies the master/grid keys as runtime-owned, ordinary prefs as not', () => {
        for (const k of [
            'view_state_json',
            'layout_json',
            'active_workspace',
            'collapsed_workspaces',
            'last_terminal_type',
        ]) {
            expect(isRuntimeOwnedSettingKey(k)).toBe(true);
        }
        for (const k of ['max_views', 'terminal_copy_paste', 'ai_system', 'notify_sound', 'remote_enabled']) {
            expect(isRuntimeOwnedSettingKey(k)).toBe(false);
        }
    });

    it('a runtime key is NEVER also host-sourced (the two classes are disjoint)', () => {
        for (const k of RUNTIME_OWNED_SETTINGS_KEYS) {
            expect(isHostSourcedSettingKey(k)).toBe(false);
        }
    });

    it('withoutRuntimeOwnedSettings drops exactly the runtime keys, keeps the rest', () => {
        const snapshot: Partial<Settings> = {
            max_views: '4',
            terminal_copy_paste: 'winmac',
            ai_system: 'be nice',
            // Runtime keys carrying a STALE snapshot the Save must not write back.
            view_state_json: '{"local|ws1":{"visibleIds":["a","b"],"focusId":null,"maximizedId":null,"layoutMode":"auto"}}',
            layout_json: '{"local|ws1|2":{"cols":[1,2],"rows":[1]}}',
            active_workspace: 'ws-stale',
            collapsed_workspaces: '["ws1"]',
        };
        const out = withoutRuntimeOwnedSettings(snapshot);
        expect(out).toEqual({
            max_views: '4',
            terminal_copy_paste: 'winmac',
            ai_system: 'be nice',
        });
        // The runtime keys are absent — the master/grid keep ownership.
        expect('view_state_json' in out).toBe(false);
        expect('layout_json' in out).toBe(false);
        expect('active_workspace' in out).toBe(false);
        expect('collapsed_workspaces' in out).toBe(false);
    });

    it('is immutable — the input snapshot is untouched', () => {
        const snapshot: Partial<Settings> = { max_views: '4', view_state_json: '{}' };
        const out = withoutRuntimeOwnedSettings(snapshot);
        expect(snapshot.view_state_json).toBe('{}');
        expect(out).not.toBe(snapshot);
    });
});
