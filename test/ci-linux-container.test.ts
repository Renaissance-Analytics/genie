import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE LINUX REAL-WINDOW ROWS RUN ON ARCH, NOT UBUNTU (Tynn issue #692; the owner, 2026-11-11: "why is our linux tests
 * using ubuntu? It should be using the omarchy image."). Omarchy is Arch: the job runs in Arch's own container image on
 * the hosted runner and installs Electron's libraries with pacman, the way Omarchy's own CI does. From 15:14Z that day
 * the Ubuntu job's first step (apt) could not resolve archive.ubuntu.com on any branch, so no real-window row ran.
 *
 * What this is NOT, said in the job's name and its summary: Arch userland in a container is not the Omarchy desktop
 * (no Hyprland, no Omarchy packages). The omarchy-test VM stays the Omarchy acceptance.
 *
 * Comments are stripped by line first: a command named in a comment is not a command.
 */
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

/** One job's text, by its id (two-space indent under `jobs:`). */
function job(id: string): string {
    const body = ci.slice(ci.indexOf('\njobs:'));
    const heads = [...body.matchAll(/\n {2}([a-z0-9-]+):\n/g)];
    const at = heads.findIndex((m) => m[1] === id);
    return at < 0 ? '' : body.slice(heads[at]!.index!, heads[at + 1]?.index ?? body.length);
}

const ROWS = [
    'node scripts/smoke-seed.mjs',
    'node scripts/agents-hold-no-pty-cdp.mjs',
    'node scripts/smoke-cdp.mjs',
    'node scripts/layout-sweep.mjs',
    'node scripts/local-door-cdp.mjs --break-admission',
    'node scripts/local-door-cdp.mjs',
    'node scripts/files-watch-cdp.mjs',
    'node scripts/chat-drafts-cdp.mjs',
    'node scripts/gapp-open-cdp.mjs',
    'node scripts/artboard-cdp.mjs --trace-main',
    'node scripts/ui-lag-cdp.mjs --budget',
    'node scripts/trust-step-cdp.mjs',
    'node scripts/site-panel-cdp.mjs',
    'node scripts/site-panel-cdp.mjs',
    'node scripts/browser-process-cdp.mjs',
    'node scripts/safe-mode-cdp.mjs',
    'node scripts/hang-cdp.mjs',
    'node scripts/renderer-crash-cdp.mjs',
];

describe('the Linux real-window job', () => {
    const smoke = job('smoke');

    it('CONTROL: the job is read, and it runs every row it ran on Ubuntu, in the same order', () => {
        expect(smoke).toContain('npx electron . --no-sandbox --remote-debugging-port=9222');
        expect(smoke.match(/node scripts\/[a-z0-9-]+\.mjs(?: --[a-z-]+)?/g)).toEqual(ROWS);
    });

    it('runs in Arch\'s own container image on the hosted runner', () => {
        expect(smoke).toMatch(/\n {4}runs-on: ubuntu-latest\n/);
        expect(smoke).toMatch(/\n {4}container:\n {6}image: ghcr\.io\/archlinux\/archlinux:latest\n/);
    });

    it('says what it is: Arch in a container, by name, and not the Omarchy desktop, in its summary', () => {
        expect(smoke).toMatch(/\n {4}name: a real window \(Arch container\)\n/);
        expect(smoke).toMatch(/Arch Linux userland in a container[^\n]*not the Omarchy desktop[^\n]*omarchy-test[^\n]*>> "\$GITHUB_STEP_SUMMARY"/);
    });

    it('installs with pacman, and nothing in it reaches for apt or sudo', () => {
        expect(smoke).not.toMatch(/\bapt(-get)?\b/);
        expect(smoke).not.toMatch(/\bsudo\b/);
        const install = /pacman -Syu --noconfirm --needed ([^\n]+)/.exec(smoke)?.[1]?.trim().split(/\s+/) ?? [];
        // The window and its display, Electron's libraries, the test keyring, and what the rows shell out to.
        expect(install).toEqual(expect.arrayContaining([
            'git', 'xorg-server-xvfb', 'xorg-xauth', 'gtk3', 'nss', 'alsa-lib', 'libnotify', 'libxss', 'libxtst', 'at-spi2-core',
            'libcups', 'libdrm', 'mesa', 'pango', 'libxcomposite', 'libxdamage', 'libxfixes', 'libxrandr', 'ttf-liberation',
            'fontconfig', 'gnome-keyring', 'libsecret', 'dbus', 'procps-ng', 'iproute2',
        ]));
    });

    it('every row runs as an ordinary user, as on a desktop: only the steps that install run as root', () => {
        expect(smoke).toMatch(/\n {4}defaults:\n {6}run:\n {8}shell: setpriv --reuid=runner --regid=runner --init-groups bash -e \{0\}\n/);
        const steps = smoke.split(/\n {6}- /).slice(1);
        const root = steps.filter((s) => /\n {8}shell: bash\n/.test(s));
        expect(root.map((s) => /^name: ([^\n]+)/.exec(s)?.[1])).toEqual([
            'Arch userland: pacman, Electron\'s libraries, an ordinary user',
            'hand the checkout and the caches to the ordinary user',
        ]);
        for (const s of root) expect(s).not.toMatch(/node scripts\//);
    });

    it('Electron\'s own binary finds every library it links, checked before the window is asked for', () => {
        const check = smoke.indexOf('ldd node_modules/electron/dist/electron');
        expect(check).toBeGreaterThan(smoke.search(/- run: npm ci\b/));
        expect(check).toBeLessThan(smoke.indexOf('npx electron .'));
    });
});

describe('what stays on Ubuntu, and why', () => {
    it('the Mailpit measurement: it starts a container itself, and a job container has no Docker', () => {
        expect(job('mailpit')).toContain('runs-on: ubuntu-latest');
        expect(job('mailpit')).not.toContain('container:');
    });

    it('packaging: the .deb and AppImage are built where the release builds them', () => {
        expect(job('package')).not.toContain('container:');
    });
});
