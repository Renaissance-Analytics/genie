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
    it('ONE opener: defined once, it brings the Genie browser WINDOW up on the URL (beta.35 item 36) — not the old pane', () => {
        expect(main.match(/const openInBrowserFor = \(activation: Activation\): OpenInBrowser => async \(url\) =>/g) ?? []).toHaveLength(1);
        const body = main.slice(main.indexOf('const openInBrowserFor = '), main.indexOf('const openInBrowserFor = ') + 600);
        // With the window the person clicked in as its anchor, where the browser opens (Tynn #739).
        expect(body).toMatch(/await openLocalBrowser\(url, activation, anchor\)/);
        expect(body).not.toMatch(/browserPane\.show|genie:navigate/);
    });

    it('the window’s opener reaches only the Hosting row (the person’s click), once; an agent’s site opens in genie-host (genie#1235, Tynn #1046 D2)', () => {
        // The agents' opener is genie-host's own, in the background (host-browser.ts hostOpensSite); none is handed out here.
        expect(main).not.toMatch(/agentOpensSite|openInBrowserFor\('background'\)/);
        expect(main.match(/openInBrowser: openInBrowserFor\('user-gesture'\),/g) ?? []).toHaveLength(1);
        const ports = main.slice(main.indexOf('const ownFeatureUi = featureWindow(localDoor, {'), main.indexOf('featureEffectNow = ownFeatureUi;'));
        expect(ports).toMatch(/openInBrowser: openInBrowserFor\('user-gesture'\),/);
    });

    it('the Edit form’s state is kept between actions, as the Add form’s is — once', () => {
        const host = readFileSync('src/main/features-host.ts', 'utf8');
        expect(host.match(/if \(caller\.live\) caller\.state = retained;/g) ?? []).toHaveLength(1);
        const rules = readFileSync('src/main/feature-hosting.ts', 'utf8');
        expect(rules).toContain('next.siteEditing =');
        expect(rules).toContain('next.siteAdding =');
        expect(main).not.toContain('featureState');
    });
});
