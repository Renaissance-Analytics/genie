import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * GENIE'S KEYS, WHERE A PERSON REMAPS THEM (Tynn #759; Genie 1's Settings → "Terminal hotkeys"). Settings → General draws
 * the Command Window key and the ForceTheQuestion nudge key as recorders — click, press — each with Reset to Genie's
 * default. The title bar's "Search, jump, run" names the key that actually opens it, remapped or not.
 */
const general = (values: Record<string, string>) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} section="keyboard" />);

describe('Settings → General → Keyboard shortcuts', () => {
    // Tynn #697: one way to set a key on this page. Each is the capture control, showing its key as keycaps.
    const capsOf = (html: string, name: string): string[] => {
        const control = html.match(new RegExp('data-hotkey-capture="' + name + '"[^>]*>(.*?)</button>'))?.[1] ?? '';
        return [...control.matchAll(/<kbd[^>]*>(.*?)<\/kbd>/g)].map((m) => m[1]!);
    };
    it('both keys, each as a capture control with its current key as keycaps; COUNTED', () => {
        const html = general({ ftq_nudge_hotkey: 'F6' });
        expect(html).toContain('data-genie-hotkeys');
        expect(html.match(/data-hotkey-capture="(?:commandWindow|ftqNudge)"/g)?.length).toBe(2);
        expect(capsOf(html, 'commandWindow')).toEqual(['Ctrl', 'K']);
        expect(capsOf(html, 'ftqNudge')).toEqual(['F6']);
        // No text box is left to type a key into.
        expect(html).not.toContain('data-binding="');
    });

    it('Reset is offered only for a key that is not Genie’s default', () => {
        const html = general({ ftq_nudge_hotkey: 'F6' });
        expect(html).toContain('data-hotkey-reset="ftqNudge"');
        expect(html).not.toContain('data-hotkey-reset="commandWindow"');
    });
});

describe('the title bar names the key that opens the Command Window', () => {
    const bar = (paletteKey?: string) =>
        renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={null} remote={null} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic" {...(paletteKey ? { paletteKey } : {})} />);
    it('Ctrl K by default; the remapped key when remapped', () => {
        expect(bar()).toContain('Ctrl K');
        expect(bar('CommandOrControl+K')).toContain('Ctrl K');
        expect(bar('CommandOrControl+Shift+P')).toContain('Ctrl+Shift+P');
        expect(bar('CommandOrControl+Shift+P')).not.toContain('Ctrl K');
    });
});
