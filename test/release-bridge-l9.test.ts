import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE BRIDGE RELEASE (Tynn #1058 L9; the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "the migration"). Every
 * installed single-app Genie reads latest.yml / latest-linux.yml through electron-updater, so the bridge is published that
 * way: a `v*` tag, its one draft, the same asset names. What it carries is no longer the single app: the launcher and the
 * packages of an approved track round (`tracks-v<build>`, L8), whose manifests were signed in the protected job, never
 * here. docs/releases/v<version>.bridge names that round's build.
 *
 *   guard           the round's file is there and names a track build, and its four track releases exist
 *   publish         (Linux) the round's four Linux packages downloaded from their releases, the bridge AppImage built from
 *                   them (scripts/build-track-packages.mjs bridge), its feed naming the round's host; uploaded to the draft
 *   publish-windows the round's Windows packages and its signed launcher, the bridge installer built and Authenticode-signed
 *                   (--signed), every signature verified, the updater files checked, uploaded to the draft
 *
 * The single app is not built again by either job.
 */
const raw = () => readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
const code = (text = raw()) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
function job(id: string, text = code()): string {
    const start = text.indexOf(`\n  ${id}:\n`);
    expect(start, `job ${id}`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}
const TRACKS = /for track in client browser host launcher; do/;

describe('the bridge release (Tynn #1058 L9): the v* tag builds the bridge from an approved round\'s signed packages', () => {
    it('guard reads the round the bridge carries, refuses a missing or wrong one, and every track release of it must exist', () => {
        const guard = job('guard');
        expect(guard).toMatch(/round="\$\(tr -d '[^']*' < "docs\/releases\/v\$tag\.bridge"\)"/);
        expect(guard).toMatch(/::error::docs\/releases\/v\$tag\.bridge is missing/);
        expect(guard).toMatch(/\^\[0-9\]\{4\}\\\.\[0-9\]\{2\}\\\.\[0-9\]\{2\}-\[0-9\]\+/);
        expect(guard).toMatch(TRACKS);
        expect(guard).toMatch(/gh release view "\$track-v\$round"[^\n]*--json tagName/);
        expect(guard).toMatch(/::error::the round \$round has no \$track release/);
        expect(guard).toMatch(/round=\$round" >> "\$GITHUB_OUTPUT"/);
        expect(guard).toMatch(/outputs:\s*\n\s*round: \$\{\{ steps\.compare\.outputs\.round \}\}/);
    });

    it('publish (Linux) downloads the round\'s four Linux packages, builds the bridge AppImage from them, and uploads it with its feed', () => {
        const publish = job('publish');
        expect(publish).toMatch(TRACKS);
        expect(publish).toMatch(/gh release download "\$track-v\$round" --repo "\$GITHUB_REPOSITORY" --dir bridge-packages --pattern "\$track-\$round-linux-x64\.\*"/);
        expect(publish).toMatch(/tar --zstd -xf "bridge-packages\/launcher-\$round-linux-x64\.tar\.zst" -C bridge-launcher genie/);
        expect(publish).toMatch(/tar --zstd -xf "bridge-packages\/host-\$round-linux-x64\.tar\.zst" -C bridge-host app\/dist\/main\/host\.js/);
        expect(publish).toMatch(/node scripts\/build-track-packages\.mjs bridge --version "\$tag" --launcher bridge-launcher\/genie --from bridge-packages --host-script bridge-host\/app\/dist\/main\/host\.js/);
        expect(publish).toMatch(/gh release upload "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY" "release\/tracks\/bridge\/Genie-\$tag\.AppImage" release\/tracks\/bridge\/latest-linux\.yml --clobber/);
        expect(publish).toMatch(/round: \$\{\{ needs\.guard\.outputs\.round \}\}/);
    });

    it('publish-windows builds the bridge installer from the round\'s signed launcher and packages, signs and verifies it, then uploads', () => {
        const windows = job('publish-windows');
        expect(windows).toMatch(TRACKS);
        expect(windows).toMatch(/gh release download "\$track-v\$round" --repo "\$GITHUB_REPOSITORY" --dir bridge-packages --pattern "\$track-\$round-win32-x64\.\*"/);
        expect(windows).toMatch(/Expand-Archive "bridge-packages\/launcher-\$\{\{ needs\.guard\.outputs\.round \}\}-win32-x64\.zip" bridge-launcher/);
        expect(windows).toMatch(/node scripts\/build-track-packages\.mjs bridge --version "\$tag" --launcher bridge-launcher\/Genie\.exe --from bridge-packages --host-script bridge-host\/app\/dist\/main\/host\.js --signed/);
        // The installer and the launcher it carries, each Renaissance Analytics' and valid, before anything is uploaded.
        expect(windows).toMatch(/Get-AuthenticodeSignature[\s\S]*Genie-\*-setup\.exe[\s\S]*bridge-launcher\/Genie\.exe/);
        expect(windows).toMatch(/Status -ne 'Valid'[\s\S]*Renaissance Analytics/);
        expect(windows).toMatch(/node scripts\/verify-windows-update\.cjs release\/tracks\/bridge release\/signature-evidence\/beta59-release-assets\.json/);
        expect(windows).toMatch(/"release\/tracks\/bridge\/Genie-\$tag-setup\.exe" "release\/tracks\/bridge\/Genie-\$tag-setup\.exe\.blockmap" release\/tracks\/bridge\/latest\.yml --clobber/);
        // The order: built, signatures verified, updater files checked, then uploaded.
        const at = (re: RegExp) => windows.search(re);
        expect(at(/build-track-packages\.mjs bridge/)).toBeLessThan(at(/Get-AuthenticodeSignature/));
        expect(at(/Get-AuthenticodeSignature/)).toBeLessThan(at(/verify-windows-update\.cjs/));
        expect(at(/verify-windows-update\.cjs/)).toBeLessThan(at(/gh release upload/));
    });

    it('the single app is not built again, and no bridge job sees the manifest signing key', () => {
        for (const id of ['publish', 'publish-windows']) {
            expect(job(id)).not.toMatch(/npx electron-builder --publish never/);
            expect(job(id)).not.toMatch(/GENIE_MANIFEST_SIGNING_KEY/);
        }
    });
});
