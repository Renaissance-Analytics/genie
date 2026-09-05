import { describe, expect, it } from 'vitest';
import { agentTuis, TUI_REGISTRY } from '../../../main/agents/registry';
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

describe('the Toolchain page is TOP-LEVEL, not buried in Hosting', () => {
    it('has its own nav item', () => {
        expect(allIds()).toContain('toolchain');
    });

    it('sits beside the Hosting Manager, not inside it', () => {
        const flat = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
        const toolchain = flat.indexOf('toolchain');
        const hosting = flat.indexOf('dev-server');
        expect(toolchain).toBeGreaterThanOrEqual(0);
        expect(hosting).toBeGreaterThanOrEqual(0);
        expect(toolchain).not.toBe(hosting);
        // Same GROUP as Hosting — the toolchain is what hosting consumes, so
        // they belong together in the sidebar even though they are two pages.
        const group = NAV_GROUPS.find((g) => g.items.some((i) => i.id === 'toolchain'))!;
        expect(group.items.map((i) => i.id)).toContain('dev-server');
    });

    it('is hidden in a remote window — it configures THIS machine', () => {
        expect(isSectionVisible('toolchain', true)).toBe(false);
    });
});

describe('workstation maintenance', () => {
    it('is a local System section beside the other machine controls', () => {
        const system = NAV_GROUPS.find((group) => group.label === 'System')!;
        expect(system.items.map((item) => item.id)).toContain('maintenance');
        expect(isSectionVisible('maintenance', false)).toBe(true);
        expect(isSectionVisible('maintenance', true)).toBe(false);
    });
});

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
        expect(items).toEqual(['customization', 'agent-providers', 'agent-mcp', 'genie-osa']);
        expect(groups.map((g) => g.label)).toEqual(['Workspace', 'Agents']);
        // The "System" group (Updates) has no visible item → dropped.
    });

    it('only Customization + Tools + Agent MCP render; everything else is hidden', () => {
        for (const id of ['customization', 'agent-providers', 'agent-mcp', 'genie-osa'] as SectionId[]) {
            expect(isSectionVisible(id, true)).toBe(true);
        }
        for (const id of [
            'general',
            'workspaces',
            'mobile',
            // The Dev Server configures THIS machine's container runtime, its
            // shared service engines and its own browser — a driving window
            // would be editing the wrong machine.
            'dev-server',
            'connections',
            'devices',
            'updates',
        ] as SectionId[]) {
            expect(isSectionVisible(id, true)).toBe(false);
        }
    });

    it('defaults to the first surviving section (Tools)', () => {
        expect(defaultSection(true)).toBe('customization');
    });
});

describe('host-sourced (bucket 2) classification', () => {
    it('Tools + Agent MCP are host-sourced; Customization is device-local', () => {
        expect(isHostSourcedSection('agent-providers')).toBe(true);
        expect(isHostSourcedSection('agent-mcp')).toBe(true);
        expect(isHostSourcedSection('genie-osa')).toBe(true);
        expect(isHostSourcedSection('customization')).toBe(false);
        expect([...HOST_SOURCED_SECTIONS].sort()).toEqual(['agent-mcp', 'agent-providers', 'genie-osa']);
    });

    it('the host-sourced key allow-list is exactly the workspace/agent-env keys', () => {
        // The provider half is DERIVED. It used to be six literals covering
        // `claude`, `codex` and `custom`, which is how `kilo` and `genie` came
        // to be missing: their command and flags were read from and written to
        // the CLIENT in a remote window, while the host is what spawns them.
        // Spelling them out again here would just be a seventh copy of the
        // provider list, and the next provider would be missing from this test
        // as well as from the list it checks.
        const providerKeys = agentTuis().flatMap((id) => [
            TUI_REGISTRY[id].commandSettingKey,
            TUI_REGISTRY[id].flagsSettingKey,
        ]);

        // POSITIVE CONTROL: the derivation is not an empty list agreeing with
        // itself — every provider must contribute exactly two keys.
        expect(providerKeys.length).toBe(agentTuis().length * 2);
        expect(providerKeys).toContain('agent_command_kilo');

        expect([...HOST_SOURCED_SETTINGS_KEYS].sort()).toEqual(
            [
                'ai_system',
                'mcp_port',
                'mcp_sync_agents',
                'mcp_sync_claude',
                'mcp_sync_codex',
                'mcp_sync_cursor',
                // Specialized-terminal launch command + flags (host resolves these).
                ...providerKeys,
                // GApp AI Provider: which TUI a Genie App's declared agents run as.
                'gapp_ai_provider',
                // Workstation Setup: the owner's default + enabled agents.
                'agent_default',
                'agent_enabled',
                'genie_os_backup_repo',
            ].sort(),
        );
    });

    it('classifies keys: agent-env → host, device prefs → local', () => {
        for (const k of [
            'ai_system',
            'mcp_port',
            'mcp_sync_claude',
            'mcp_sync_cursor',
            'mcp_sync_codex',
            'mcp_sync_agents',
            'agent_command_claude',
            'agent_flags_claude',
            'agent_command_codex',
            'agent_flags_codex',
            'agent_command_custom',
            'agent_flags_custom',
            'gapp_ai_provider',
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
                // The machine's default language versions. Written by the
                // Toolchain page's OWN ipc (a targeted patch), never by the
                // Settings form — so the form's stale whole-object Save must
                // not carry an old value back over it.
                'toolchain_defaults',
            ].sort(),
        );
    });

    it('never lets a Settings Save revert the machine’s toolchain defaults', () => {
        // The exact failure this guards: open Settings, switch the default PHP
        // on the Toolchain page, click Save on some unrelated row — and the
        // pre-switch snapshot writes the old default back, silently moving every
        // unpinned site to the wrong runtime on its next start.
        const out = withoutRuntimeOwnedSettings({
            max_views: '4',
            toolchain_defaults: '{"php":"8.2.33"}',
        });
        expect('toolchain_defaults' in out).toBe(false);
        expect(out).toEqual({ max_views: '4' });
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
