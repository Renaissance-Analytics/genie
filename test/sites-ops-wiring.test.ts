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
        expect(body).toMatch(/genieBrowserWindow\.open\(url, activation\)/);
        expect(body).not.toMatch(/browserPane\.show|genie:navigate/);
    });

    it('the same opener reaches the agents’ tools (background) and the Hosting row (the person’s click) — once each (genie#1235)', () => {
        // The agents' opener is the background one, and pulses the site's workspace (genie#1265, agent-actions-pulse-wiring).
        expect(main.match(/openInBrowser: agentOpensSite,/g) ?? []).toHaveLength(1);
        expect(main.match(/openInBrowserFor\('background'\)\(url\)/g) ?? []).toHaveLength(1);
        expect(main.match(/openInBrowser: openInBrowserFor\('user-gesture'\),/g) ?? []).toHaveLength(1);
        const ports = main.slice(main.indexOf('const featurePorts: FeaturePorts = {'), main.indexOf('const featurePorts: FeaturePorts = {') + 200);
        expect(ports).toMatch(/openInBrowser: openInBrowserFor\('user-gesture'\),/);
    });

    it('the Edit form’s state is kept between actions, as the Add form’s is — once', () => {
        expect(main.match(/siteEditing: data\.hosting\?\.editing \?\? null/g) ?? []).toHaveLength(1);
    });
});
