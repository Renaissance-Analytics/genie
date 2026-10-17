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
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} group="general" />);

describe('Settings → General → Keyboard shortcuts', () => {
    it('both keys, each as a recorder with its current key; COUNTED', () => {
        const html = general({ ftq_nudge_hotkey: 'F6' });
        expect(html).toContain('data-genie-hotkeys');
        expect(html.match(/data-binding="/g)?.length).toBe(2);
        expect(html).toMatch(/data-binding="commandWindow"[^>]*value="Ctrl\+K"|value="Ctrl\+K"[^>]*data-binding="commandWindow"/);
        expect(html).toMatch(/data-binding="ftqNudge"[^>]*value="F6"|value="F6"[^>]*data-binding="ftqNudge"/);
    });

    it('Reset is offered only for a key that is not Genie’s default', () => {
        const html = general({ ftq_nudge_hotkey: 'F6' });
        expect(html).toContain('data-action="binding-reset-ftqNudge"');
        expect(html).not.toContain('data-action="binding-reset-commandWindow"');
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
