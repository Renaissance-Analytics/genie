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
    it('each alert row offers the sounds by name, None last; COUNTED: five rows of six choices', () => {
        const html = general({});
        const rows = html.match(/<li[^>]*data-setting="sound_[a-z]+"[\s\S]*?<\/li>/g) ?? [];
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            expect(row.match(/<option /g)).toHaveLength(6);
            expect(row).toContain('>Wind Down</option>');
            expect(row).toMatch(/value="off"[^>]*>None<\/option><\/select>/);
        }
    });

    it('the person’s choice is the selected one; CONTROL: an untouched row selects its own sound', () => {
        const html = general({ sound_finished: 'sparkle' });
        const finished = html.match(/<li[^>]*data-setting="sound_finished"[\s\S]*?<\/li>/)![0];
        expect(finished).toMatch(/<option value="sparkle" selected="">Sparkle<\/option>/);
        const question = html.match(/<li[^>]*data-setting="sound_question"[\s\S]*?<\/li>/)![0];
        expect(question).toMatch(/<option value="dingdongdoink" selected="">Ding Dong Doink<\/option>/);
    });
});
