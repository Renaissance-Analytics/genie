import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE SOUND PICKER IN SETTINGS → GENERAL (Tynn #766; the owner, 2026-10-17: "what happened to the action sounds settings
 * we had?"). Genie 1 offered a sound per alert, by NAME; Genie 2 had an on/off box. Each alert row is now a choice that
 * reads as words — "Wind Down", not `winddown` — with the person's choice named on its Button (Tynn #711: the sounds themselves are in its popover).
 */
const general = (values: Record<string, boolean | string>) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} section="notifications" />);

describe('a sound per alert', () => {
    it('each alert row is ONE Button naming its sound (Tynn #711); the popover of groups and play buttons opens from it, so a closed row holds no native select, option or play button; COUNTED: twenty-six rows', () => {
        const html = general({});
        const rows = html.match(/<li[^>]*data-setting="sound_[a-z]+"[\s\S]*?<\/li>/g) ?? [];
        expect(rows).toHaveLength(26);
        for (const row of rows) {
            expect(row.match(/data-sound-picker=""/g)).toHaveLength(1);
            expect(row).toMatch(/<button[^>]*data-sound-picker=""[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
            expect(row).not.toMatch(/<select|<option|<optgroup/);
            expect(row).not.toContain('data-sound-play');
            expect(row).not.toContain('data-sound-popover');
        }
        expect(rows.find((r) => r.includes('data-setting="sound_finished"'))).toContain('<span class="truncate">Triumphant</span>');
    });

    it('a row names None exactly where it is None (COUNTED: twenty-one), and the Button names the sound otherwise', () => {
        const html = general({ sound_mail: 'off', sound_edits: 'sparkle' });
        const rows = html.match(/<li[^>]*data-setting="sound_[a-z]+"[\s\S]*?<\/li>/g) ?? [];
        const none = rows.filter((r) => r.includes('<span class="truncate">None</span>')).map((r) => r.match(/data-setting="(sound_[a-z]+)"/)![1]).sort();
        // Mail set to None, and the kinds that default to None — except edits, given Sparkle here.
        expect(none).toEqual(['sound_agentmail', 'sound_exits', 'sound_fetches', 'sound_flowdone', 'sound_ghci', 'sound_ghissue', 'sound_ghpr', 'sound_ghsecurity', 'sound_limited', 'sound_mail', 'sound_plans', 'sound_reads', 'sound_replied', 'sound_resumed', 'sound_runs', 'sound_serviceup', 'sound_sitedown', 'sound_siteup', 'sound_started', 'sound_stopped', 'sound_thumbsup']);
        expect(rows.find((r) => r.includes('data-setting="sound_edits"'))).toContain('<span class="truncate">Sparkle</span>');
    });

    it('the sound rows are shown in their groups — Needs you, Its turn, Its work, Messages — each kind once (COUNTED)', () => {
        const html = general({});
        const groups = [...html.matchAll(/data-sound-group="([a-z-]+)"[\s\S]*?(?=data-sound-group=|$)/g)].map((m) => [m[1], (m[0].match(/<li[^>]*data-setting="sound_[a-z]+"/g) ?? []).length]);
        expect(groups).toEqual([['needs-you', 4], ['turn', 6], ['work', 5], ['messages', 2], ['things', 5], ['github', 4]]);
        expect(html).toMatch(/data-sound-group="needs-you"[^>]*>[\s\S]*?Needs you/);
    });

    it('a custom file is named on its row, with Change…; CONTROL: a row without one shows no file', () => {
        const html = general({ sound_question: 'custom', sound_question_custom: '/home/a/sounds/ding.mp3' });
        const question = html.match(/<li[^>]*data-setting="sound_question"[\s\S]*?<\/li>/)![0];
        expect(question).toMatch(/data-sound-custom="sound_question"[^>]*>[\s\S]*ding\.mp3/);
        expect(question).toContain('data-action="sound-pick"');
        const finished = html.match(/<li[^>]*data-setting="sound_finished"[\s\S]*?<\/li>/)![0];
        expect(finished).not.toContain('data-sound-custom');
    });

    it('the person’s choice is the one the Button names; CONTROL: an untouched row names its own sound (the selected row inside the popover is marked in sound-picker.test.tsx)', () => {
        const html = general({ sound_finished: 'sparkle' });
        const finished = html.match(/<li[^>]*data-setting="sound_finished"[\s\S]*?<\/li>/)![0];
        expect(finished).toMatch(/data-sound-picker=""[\s\S]*?<span class="truncate">Sparkle<\/span>/);
        expect(finished).not.toContain('Triumphant');
        const question = html.match(/<li[^>]*data-setting="sound_question"[\s\S]*?<\/li>/)![0];
        expect(question).toMatch(/data-sound-picker=""[\s\S]*?<span class="truncate">Ding Dong Doink<\/span>/);
    });
});
