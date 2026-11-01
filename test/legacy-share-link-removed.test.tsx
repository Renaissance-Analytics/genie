import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/core/remote-protocol.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE OLD LOCAL SHARE LINK IS GONE AND STAYS GONE (audit M-d). Before Tynn links, a host could mint
 * `https://<hostname>/share/<id>#<secret>` from Settings → Workstation → Sharing, redeemed by a `share` hello on the tailnet
 * socket. No client ever sent that hello, its URL host (`os.hostname()`) reached nothing, and it bypassed every Tynn rule
 * (one session, drones take links only, read-only links): reusable until it expired, alive after revoke for a connected
 * guest, always control. Sharing is Tynn's link now (tynn-share-links.ts). The links lived in memory only, so there is no
 * stored state to clean up.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): { file: string; text: string }[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(ts|tsx)$/.test(name) ? [{ file: path.slice(SRC.length).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }] : [];
    });
}

/** Code only: a comment line that names a removed thing (to say it was removed) is not a use of it. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** What the local share link was made of. Any one coming back is the feature coming back. */
const REMOVED: ReadonlyArray<[string, RegExp]> = [
    ['the ShareLinks class', /\bShareLinks\b/],
    ['the remote.mintShare action', /remote\.mintShare/],
    ['the remote.revokeShare action', /remote\.revokeShare/],
    ['the once-served local URL', /\bservedLink\b/],
    ['the share hello', /kind\s*(?::|===)\s*'share'/],
    ['the Settings mint form', /data-form="mint-share"/],
];

describe('a share hello is not part of the protocol', () => {
    it('a hello with a share {id, secret} is refused at parse, before any host sees it', () => {
        expect(parseMessage(JSON.stringify({ kind: 'hello', auth: { kind: 'share', id: 'share_x', secret: 's' } })).ok).toBe(false);
    });

    it('CONTROL: a pin hello and a relay hello still parse', () => {
        expect(parseMessage(JSON.stringify({ kind: 'hello', auth: { kind: 'pin', code: '123456' } })).ok).toBe(true);
        expect(parseMessage(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } })).ok).toBe(true);
    });
});

describe('Settings → Workstation has no local Sharing section', () => {
    const remote = {
        host: 'alphar', url: 'wss://alphar.tailnet.invalid:7421', unavailable: null, locked: false, pin: { code: '482913', expiresAt: 10 },
        devices: [], connections: [], enabled: true, firewall: false,
    } as NonNullable<FeatureData['remote']>;
    const html = renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote }} onAction={() => {}} onNavigate={() => {}} section="remote" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

    it('no Sharing heading, no mint form, no once-shown URL', () => {
        expect(html).not.toMatch(/>Sharing</);
        expect(html).not.toContain('data-form="mint-share"');
        expect(html).not.toContain('data-served-link');
    });

    it('CONTROL: the section rendered (the PIN is there)', () => {
        expect(html).toContain('data-pin="482913"');
    });
});

describe('source guard: nothing of the local share link is left in src/', () => {
    it('CONTROL: each pattern finds the thing it forbids, and not a comment naming it', () => {
        const samples = ['new ShareLinks({})', "onAction({ kind: 'remote.mintShare' })", "case 'remote.revokeShare':", 'next.servedLink = x', "auth.kind === 'share'", '<form data-form="mint-share">'];
        REMOVED.forEach(([, pattern], i) => expect(pattern.test(code(samples[i]!))).toBe(true));
        expect(/\bShareLinks\b/.test(code('    // the old ShareLinks class was removed'))).toBe(false);
        // The Tynn link is not the removed thing.
        expect(REMOVED.some(([, p]) => p.test("import { listShareLinks } from './tynn-share-links.js'"))).toBe(false);
    });

    it('COUNTED: the scan reads all of src/, and no file holds any of it', () => {
        const all = sources(SRC);
        expect(all.length).toBeGreaterThan(100);
        expect(all.some((s) => s.file === 'main/remote-host.ts')).toBe(true);
        const found = all.flatMap((s) => REMOVED.filter(([, p]) => p.test(code(s.text))).map(([what]) => `${s.file}: ${what}`));
        expect(found).toEqual([]);
    });
});
