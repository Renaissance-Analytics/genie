import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A PASTED IMAGE'S PILL SHOWS ITS THUMBNAIL (beta.33 item 17). The owner (2026-10-20): "I need to be able to see a
 * thumbnail of a pasted image on hover, right now it shows an empty tooltip."
 *
 * The thumbnail is react-fancy's (`PastePills/InlinePill.tsx` `ImageThumb`): the pasted File shown through
 * `URL.createObjectURL` — a `blob:` URL. Genie's windows allowed images from `'self'` and `data:` only, so the browser
 * refused the blob and the preview drew nothing. The windows with a composer must allow `blob:` images — and loosen
 * nothing else.
 */
const root = join(import.meta.dirname, '..');
const cspOf = (file: string): Map<string, string[]> => {
    const html = readFileSync(join(root, file), 'utf8');
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(content, `${file} has a CSP`).toBeDefined();
    return new Map(content!.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name!, values]; }));
};

describe('the windows with a composer allow a pasted image’s thumbnail', () => {
    // index.html is the main window (the chat's composer); doctor.html is the doctor window, which has one too.
    for (const file of ['index.html', 'doctor.html']) {
        it(`${file}: img-src allows blob: — and still 'self' and data:`, () => {
            const img = cspOf(file).get('img-src') ?? [];
            expect(img).toContain('blob:');
            expect(img).toContain("'self'");
            expect(img).toContain('data:');
        });

        it(`${file}: nothing else is loosened — no blob: for scripts, default-src still 'none'`, () => {
            const csp = cspOf(file);
            expect(csp.get('default-src')).toEqual(["'none'"]);
            expect(csp.get('script-src')).toEqual(["'self'"]);
            // Only the image directive names blob:.
            expect([...csp.entries()].filter(([, v]) => v.includes('blob:')).map(([k]) => k)).toEqual(['img-src']);
        });
    }
});
