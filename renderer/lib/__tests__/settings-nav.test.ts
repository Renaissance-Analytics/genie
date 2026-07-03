import { describe, expect, it } from 'vitest';
import {
    NAV_GROUPS,
    HOST_SOURCED_SETTINGS_KEYS,
    HOST_SOURCED_SECTIONS,
    defaultSection,
    filterNavGroups,
    isHostSourcedSection,
    isHostSourcedSettingKey,
    isSectionVisible,
    type SectionId,
} from '../settings-nav';

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
            'work_mode',
            'auto_update',
        ]) {
            expect(isHostSourcedSettingKey(k)).toBe(false);
        }
    });
});
