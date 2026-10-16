import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * MAIN WIRES THE SITE ROW'S OPEN AND EDIT (S6). main.ts cannot be composed in a test — it is Electron — so its lines are
 * read: ONE browser opener is handed to both the Hosting row (feature ports) and the agents' `sites open` (tool deps),
 * so the person and an agent open a site the same way; and the Edit form's state survives from one action to the next,
 * as the Add form's does. Comments are stripped line by line first (CRLF-safe), so a mention in prose is no wiring.
 */

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('main wires the site row', () => {
    it('ONE opener: defined once, it shows Genie’s browser pane and brings the browser surface up on the URL', () => {
        expect(main.match(/const openInBrowser: OpenInBrowser = async \(url\) =>/g) ?? []).toHaveLength(1);
        const body = main.slice(main.indexOf('const openInBrowser: OpenInBrowser'), main.indexOf('const openInBrowser: OpenInBrowser') + 600);
        expect(body).toMatch(/browserPane\.show\(url\)/);
        expect(body).toMatch(/broadcast\('genie:navigate', browserRoute\.format\(\{ url \}\)\)/);
    });

    it('the same opener reaches the agents’ tools and the Hosting row — once each', () => {
        // genieToolDeps({ … openInBrowser, … }) and featurePorts = { … openInBrowser, … }: two shorthand uses, no third copy.
        expect(main.match(/^\s*openInBrowser,\s*$/gm) ?? []).toHaveLength(2);
        const ports = main.slice(main.indexOf('const featurePorts: FeaturePorts = {'), main.indexOf('const featurePorts: FeaturePorts = {') + 200);
        expect(ports).toMatch(/openInBrowser,/);
    });

    it('the Edit form’s state is kept between actions, as the Add form’s is — once', () => {
        expect(main.match(/siteEditing: data\.hosting\?\.editing \?\? null/g) ?? []).toHaveLength(1);
    });
});
