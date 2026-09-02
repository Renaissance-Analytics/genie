import { describe, expect, it } from 'vitest';
import {
    SETTING_TIERS,
    settingTier,
    keysInTier,
    type SettingTier,
} from '../setting-tiers';
import { HOST_SOURCED_SETTINGS_KEYS, RUNTIME_OWNED_SETTINGS_KEYS } from '../settings-nav';

/**
 * THREE TIERS, and none of them touch each other (owner directive 2026-09-02).
 *
 *   Workspace    — PORTABLE. Moves with the folder; a collaborator who clones
 *                  the workspace inherits it. Lives in `project.json`, whose
 *                  contract is the shared registry's `project.schema.json`.
 *   Workstation  — STREAMABLE. About THIS machine; a remote client reads and
 *                  writes it against the host.
 *   User         — SYNCABLE via Tynn, per user and global across every project.
 *                  Experience, not functionality.
 *
 * WHY THIS IS NOT A RENAME OF THE EXISTING SPLIT. `settings-nav.ts` already
 * documents a "3-way split", but it answers a DIFFERENT question: in a REMOTE
 * window, where does this value come from — client-local, host-sourced, or
 * hidden? That is about sourcing. This is about OWNERSHIP and how a setting
 * travels.
 *
 * The two axes are close enough to be confused and must not be:
 *
 *   - `HOST_SOURCED_SETTINGS_KEYS` ≈ the workstation tier, and the test below
 *     pins that overlap so the two lists cannot silently disagree.
 *   - "client-local" is NOT the user tier. In a LOCAL window the client IS the
 *     workstation, so today client-local holds user preferences (theme, sounds,
 *     DND) and machine settings (startup, hotkeys, ports, updates) with nothing
 *     distinguishing them. Separating those two is the actual work here.
 *
 * `RUNTIME_OWNED_SETTINGS_KEYS` is a THIRD, orthogonal thing — the keys the
 * Settings window must not clobber on a whole-object save. A runtime-owned key
 * still belongs to exactly one tier, and the test below says so rather than
 * letting the two ideas blur.
 */

describe('every setting belongs to exactly one tier', () => {
    it('assigns a tier to every key, with no key in two tiers', () => {
        const seen = new Map<string, SettingTier>();
        for (const [key, tier] of Object.entries(SETTING_TIERS)) {
            expect(seen.has(key)).toBe(false);
            seen.set(key, tier);
        }
        expect(seen.size).toBe(Object.keys(SETTING_TIERS).length);
    });

    it('uses no tier outside the three', () => {
        // A SUBSET check, not an equality one. `workspace` is legitimately
        // absent from the values today (see the control below), so asserting
        // all three appear would be asserting that the tier is populated —
        // a different claim, and currently a false one.
        const allowed: SettingTier[] = ['workspace', 'workstation', 'user'];
        for (const tier of Object.values(SETTING_TIERS)) {
            expect(allowed).toContain(tier);
        }
    });

    /**
     * The WORKSPACE tier is deliberately EMPTY today, and that is a finding
     * rather than an oversight.
     *
     * Every current setting turned out to be about the machine or the person.
     * `ai_system` reads like a workspace setting and is not — it is "injected
     * into EVERY workspace's AGENTS.md", so it is workstation-wide.
     * `max_agent_terminals` is the workstation DEFAULT; the per-workspace
     * override is a different store a human writes.
     *
     * So slice 5 is not "move some keys into the portable tier" — it is
     * creating that tier's first members in `project.json`. Asserting the tier
     * is populated would have forced a wrong classification to make a test
     * green, which is how a tier boundary rots on day one.
     */
    it('POSITIVE CONTROL: the two populated tiers are real, and workspace is knowingly empty', () => {
        expect(keysInTier('workstation').length).toBeGreaterThan(5);
        expect(keysInTier('user').length).toBeGreaterThan(5);
        expect(keysInTier('workspace')).toEqual([]);
    });
});

/**
 * The overlap with the sourcing axis, pinned in the one direction that must
 * hold. A host-sourced key is BY DEFINITION about the host machine, so it is a
 * workstation setting.
 *
 * The converse is deliberately NOT asserted: a workstation setting need not be
 * host-sourced. Startup, updates and the quick-capture hotkey configure the
 * client's own machine and are hidden in a remote window rather than streamed
 * from the host — they are still workstation-tier, just not host-sourced.
 */
describe('the tiers agree with the remote-sourcing axis', () => {
    it('classifies every host-sourced key as a workstation setting', () => {
        for (const key of HOST_SOURCED_SETTINGS_KEYS) {
            expect(settingTier(key)).toBe('workstation');
        }
    });

    it('POSITIVE CONTROL: that list is real and non-trivial', () => {
        expect(HOST_SOURCED_SETTINGS_KEYS.length).toBeGreaterThan(10);
    });
});

describe('runtime-owned keys are orthogonal to the tiers', () => {
    it('still assigns each runtime-owned key exactly one tier', () => {
        // Runtime-owned answers "may the Settings save write this", not "who
        // owns it". Both must be answerable for the same key.
        for (const key of RUNTIME_OWNED_SETTINGS_KEYS) {
            expect(settingTier(key)).toBeDefined();
        }
    });
});

/**
 * The classifications worth naming outright, because they are the ones a future
 * change is most likely to get wrong.
 */
describe('the judgement calls', () => {
    it('puts experience settings in the user tier', () => {
        for (const key of [
            'notify_sound',
            'notify_toast',
            'sound_imdone',
            'sound_forcequestion',
            'ftq_dnd_message',
            'ftq_dnd_sound',
            'terminal_copy_paste',
        ] as const) {
            expect(settingTier(key)).toBe('user');
        }
    });

    it('keeps the Tynn connection in the user tier, as the named exception', () => {
        // Functional rather than experiential, but it belongs to the PERSON and
        // travels with them between machines — the owner's stated exception.
        expect(settingTier('tynn_host')).toBe('user');
    });

    it('keeps machine configuration in the workstation tier', () => {
        for (const key of [
            'mcp_port',
            'mobile_port',
            'auto_update',
            'start_minimized',
            'terminal_shell',
            'toolchain_defaults',
            'remote_enabled',
        ] as const) {
            expect(settingTier(key)).toBe('workstation');
        }
    });

    it('does NOT mistake workstation-wide settings for workspace ones', () => {
        // The three most misreadable keys. `ai_system` is injected into EVERY
        // workspace on this machine, `max_agent_terminals` is the workstation
        // default behind a per-workspace override, and `default_env_file` is a
        // machine default. All three read as "workspace" and are not.
        for (const key of ['ai_system', 'default_env_file', 'max_agent_terminals'] as const) {
            expect(settingTier(key)).toBe('workstation');
        }
    });
});
