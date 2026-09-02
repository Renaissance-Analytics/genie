import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, TUI_REGISTRY } from '../../../main/agents/registry';
import { providerSettingsGroups, gappProviderOptions } from '../provider-settings';

/**
 * The Providers settings section is DERIVED from the registry (genie#261).
 *
 * `registry.ts` exists because the provider set used to be restated in ~37
 * places, of which only ~11 were compiler-enforced: *"they do not fail to
 * BUILD, they fail to WORK"*. The settings page was one of the unenforced
 * ones, and it had already drifted — it hand-rolled a command row and a flags
 * row for `claude`, `codex` and `custom`, and knew nothing about `kiwi` or
 * `genie`.
 *
 * That is not cosmetic. `agent_command_kiwi`, `agent_flags_kiwi`,
 * `agent_command_genie` and `agent_flags_genie` are real settings keys the
 * launcher reads — so both providers were launchable but had no way for the
 * owner to set their command or flags. The "Custom agent" row was the only
 * escape hatch, and it points at a different provider entirely.
 *
 * The same drift had hit the GApp provider select, which offered three of the
 * five.
 *
 * So the model is a pure function over the registry, and these tests pin the
 * property that matters: adding a provider to the table makes it appear here,
 * and a page that hand-rolls a row cannot silently miss one again.
 */

describe('provider settings model', () => {
    it('covers every provider in the registry, in registry order', () => {
        expect(providerSettingsGroups().map((g) => g.id)).toEqual([...PROVIDER_IDS]);
    });

    it('carries the settings keys the launcher actually reads', () => {
        for (const group of providerSettingsGroups()) {
            const def = TUI_REGISTRY[group.id];
            expect(group.commandKey).toBe(def.commandSettingKey);
            expect(group.flagsKey).toBe(def.flagsSettingKey);
            expect(group.label).toBe(def.label);
        }
    });

    it('includes the two providers the old page had no rows for', () => {
        // The regression this file exists for, named outright so it cannot be
        // refactored away as an incidental assertion.
        const ids = providerSettingsGroups().map((g) => g.id);
        expect(ids).toContain('kiwi');
        expect(ids).toContain('genie');
    });

    /**
     * `custom` has `defaultCommand: ''` on purpose — "a custom agent IS its
     * command, so an empty default is the honest answer rather than a guess
     * that would launch the wrong thing". A placeholder showing a real command
     * would be exactly that guess, so it gets an example instead.
     */
    it('offers a real default as the command placeholder, except for custom', () => {
        for (const group of providerSettingsGroups()) {
            if (group.id === 'custom') {
                expect(group.commandPlaceholder).not.toBe('');
                expect(TUI_REGISTRY.custom.defaultCommand).toBe('');
                continue;
            }
            expect(group.commandPlaceholder).toBe(TUI_REGISTRY[group.id].defaultCommand);
        }
    });

    it('makes every group searchable by its own provider name', () => {
        for (const group of providerSettingsGroups()) {
            expect(group.keywords.toLowerCase()).toContain(group.id);
        }
    });
});

describe('GApp provider options', () => {
    it('offers every provider plus the follow-the-default entry', () => {
        const options = gappProviderOptions();

        expect(options[0]!.value).toBe('');
        expect(options.slice(1).map((o) => o.value)).toEqual([...PROVIDER_IDS]);
    });
});

/**
 * STRUCTURAL GUARD. The model above can be perfect while the page ignores it —
 * which is precisely how the old section drifted. This fails the build if
 * `settings.tsx` names a provider settings key directly again.
 */
describe('the settings page does not hand-roll provider rows', () => {
    const settingsPath = path.resolve(__dirname, '../../pages/settings.tsx');

    it('names no agent_command_/agent_flags_ key literally', () => {
        const src = fs.readFileSync(settingsPath, 'utf8');
        const offenders = [...src.matchAll(/agent_(?:command|flags)_[a-z]+/g)].map((m) => m[0]);

        expect([...new Set(offenders)]).toEqual([]);
    });

    it('POSITIVE CONTROL: the scan reads the real page, and the page still has settings', () => {
        // Without this, a bad path yields an empty string and the test above
        // passes against nothing at all — the way a negative test rots.
        const src = fs.readFileSync(settingsPath, 'utf8');

        expect(src.length).toBeGreaterThan(2000);
        expect(src).toContain('SettingRow');
        expect(src).toContain('gapp_ai_provider');
    });

    it('POSITIVE CONTROL: the offender pattern really matches a hand-rolled key', () => {
        // Guards the regex itself: a broken pattern would report "no offenders"
        // forever and the guard would be worthless.
        const sample = "value={s.agent_command_claude ?? ''}";

        expect(/agent_(?:command|flags)_[a-z]+/.test(sample)).toBe(true);
    });
});

/**
 * The host-key list is the OTHER copy of the provider set, and the one with
 * teeth (`renderer/lib/settings-nav.ts`).
 *
 * Its own comment says why: these keys are "badged 'On the host' in Settings,
 * so their VALUES must come from + write to it" — `resolveAgentLaunch` reads
 * them on the host when it spawns an agent. A provider missing from this list
 * does not merely look wrong; its command and flags are read from, and written
 * to, the wrong side. `kiwi` and `genie` were both missing, so even once the
 * page rendered their rows the values would not have reached the launcher.
 */
describe('every provider key is host-sourced', () => {
    it('lists the command and flags key for every provider', async () => {
        const { HOST_SOURCED_SETTINGS_KEYS: keys } = await import('../settings-nav');

        for (const group of providerSettingsGroups()) {
            expect(keys).toContain(group.commandKey);
            expect(keys).toContain(group.flagsKey);
        }
    });

    it('POSITIVE CONTROL: the list is a real, populated list', async () => {
        // Without this, `toContain` on an undefined import would be the failure
        // rather than the assertion, and an empty list would look like success
        // to a reader skimming a green run.
        const { HOST_SOURCED_SETTINGS_KEYS: keys } = await import('../settings-nav');

        expect(Array.isArray(keys)).toBe(true);
        expect(keys.length).toBeGreaterThan(10);
        expect(keys).toContain('gapp_ai_provider');
    });
});
