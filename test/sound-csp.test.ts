import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE SOUNDS ARE ALLOWED TO LOAD (the owner, 2026-10-19: "None of the sounds work at all").
 *
 * Measured cause: the main window's Content-Security-Policy is `default-src 'none'` and named no `media-src`, so media
 * fell back to 'none' — every `<audio>` load was refused: the shipped .wav sounds (the defaults of Asks, Waits for
 * approval, Broken, Finished and Mail) and your own sound files, which reach the window as `data:` URLs
 * (feature-ipc.ts customSoundData). The player swallows a refused play by design, so nothing said so. Only the
 * synthesized Default chime (Web Audio oscillators, not media) could ever sound.
 *
 * The real-window half of this is smoke check 51 (scripts/smoke-cdp.mjs): the window loads a bundled .wav, with no
 * policy violation.
 */
function csp(file: string): Map<string, string[]> {
    const html = readFileSync(file, 'utf8');
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    return new Map(content.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name = '', ...src] = d.split(/\s+/); return [name, src]; }));
}

describe('the main window’s Content-Security-Policy', () => {
    it('media from the app’s own files and from data: URLs (your own sound files) — and nothing else', () => {
        const policy = csp('index.html');
        expect(policy.get('media-src')?.sort()).toEqual(["'self'", 'data:'].sort());
    });

    it('CONTROL: everything else stays as locked down as it was — default none, scripts only from the app', () => {
        const policy = csp('index.html');
        expect(policy.get('default-src')).toEqual(["'none'"]);
        expect(policy.get('script-src')).toEqual(["'self'"]);
    });
});
