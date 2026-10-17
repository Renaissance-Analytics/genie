import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE SOUND PICKER IN SETTINGS → GENERAL (Tynn #766; the owner, 2026-10-17: "what happened to the action sounds settings
 * we had?"). Genie 1 offered a sound per alert, by NAME; Genie 2 had an on/off box. Each alert row is now a choice that
 * reads as words — "Wind Down", not `winddown` — with the person's choice selected, and None last.
 */
const general = (values: Record<string, boolean | string>) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} group="general" />);

describe('a sound per alert', () => {
    it('each alert row offers the sounds by name — the Default chime first, Custom file…, None last; COUNTED: seventeen rows of eight choices', () => {
        const html = general({});
        const rows = html.match(/<li[^>]*data-setting="sound_[a-z]+"[\s\S]*?<\/li>/g) ?? [];
        expect(rows).toHaveLength(17);
        for (const row of rows) {
            expect(row.match(/<option /g)).toHaveLength(8);
            expect(row).toMatch(/value="custom"[^>]*>Custom file…<\/option><option value="off"/);
            expect(row).toMatch(/<select[^>]*><option value="synth"[^>]*>Default chime<\/option>/);
            expect(row).toContain('>Wind Down</option>');
            expect(row).toMatch(/value="off"[^>]*>None<\/option><\/select>/);
        }
    });

    it('each row has Preview — the sound it would play; None has nothing to preview (COUNTED: seventeen; disabled exactly where None)', () => {
        const html = general({ sound_mail: 'off', sound_edits: 'sparkle' });
        const previews = html.match(/<button[^>]*data-sound-preview="sound_[a-z]+"[^>]*>/g) ?? [];
        expect(previews).toHaveLength(17);
        const disabled = previews.filter((b) => / disabled=""/.test(b)).map((b) => b.match(/data-sound-preview="(sound_[a-z]+)"/)![1]).sort();
        // Mail set to None, and the new kinds that default to None — except edits, given Sparkle here.
        expect(disabled).toEqual(['sound_agentmail', 'sound_fetches', 'sound_limited', 'sound_mail', 'sound_plans', 'sound_reads', 'sound_replied', 'sound_resumed', 'sound_runs', 'sound_started', 'sound_stopped', 'sound_thumbsup']);
    });

    it('the sound rows are shown in their groups — Needs you, Its turn, Its work, Messages — each kind once (COUNTED)', () => {
        const html = general({});
        const groups = [...html.matchAll(/data-sound-group="([a-z-]+)"[\s\S]*?(?=data-sound-group=|$)/g)].map((m) => [m[1], (m[0].match(/<li[^>]*data-setting="sound_[a-z]+"/g) ?? []).length]);
        expect(groups).toEqual([['needs-you', 4], ['turn', 6], ['work', 5], ['messages', 2]]);
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

    it('the person’s choice is the selected one; CONTROL: an untouched row selects its own sound', () => {
        const html = general({ sound_finished: 'sparkle' });
        const finished = html.match(/<li[^>]*data-setting="sound_finished"[\s\S]*?<\/li>/)![0];
        expect(finished).toMatch(/<option value="sparkle" selected="">Sparkle<\/option>/);
        const question = html.match(/<li[^>]*data-setting="sound_question"[\s\S]*?<\/li>/)![0];
        expect(question).toMatch(/<option value="dingdongdoink" selected="">Ding Dong Doink<\/option>/);
    });
});
