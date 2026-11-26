import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAUNCHER_ENV, launcherLink } from '../src/core/launcher-link.js';
import { winLauncherPath } from '../src/main/win-launcher.js';

/*
 * A CLIENT THE LAUNCHER STARTED (Tynn #1058 L3). The launcher starts genie-client from its own track's folder and tells it
 * two things: where the launcher is (GENIE_LAUNCHER_EXE: genie-launch.exe's modes are the launcher's now) and the build
 * of the host it started (GENIE_LAUNCHER_HOST_BUILD). Such a client carries no host bundle, so it makes no host copy and
 * links to the host the launcher named, whose build is the host track's, not a hash of a host.js it does not have.
 * Removing the client's start and replace branches altogether is L4.
 */
describe('the launcher\'s word to the client', () => {
    it('reads the launcher and the host build it was given', () => {
        expect(launcherLink({ GENIE_LAUNCHER_EXE: 'C:\\Users\\a\\AppData\\Local\\Programs\\Genie\\Genie.exe', GENIE_LAUNCHER_HOST_BUILD: '2026.11.26-1' }))
            .toEqual({ launcherExe: 'C:\\Users\\a\\AppData\\Local\\Programs\\Genie\\Genie.exe', hostBuild: '2026.11.26-1' });
        expect(launcherLink({ GENIE_LAUNCHER_EXE: '/home/a/.local/share/genie/launcher/2026.11.26-1/genie' }))
            .toEqual({ launcherExe: '/home/a/.local/share/genie/launcher/2026.11.26-1/genie', hostBuild: null });
    });

    it('a client nobody launched (a dev run, the single-app install) is not one', () => {
        expect(launcherLink({})).toBeNull();
        expect(launcherLink({ GENIE_LAUNCHER_HOST_BUILD: '2026.11.26-1' })).toBeNull();
    });

    it('takes only an absolute launcher path and a track build, nothing a workspace could plant', () => {
        expect(launcherLink({ GENIE_LAUNCHER_EXE: 'Genie.exe' })).toBeNull();
        expect(launcherLink({ GENIE_LAUNCHER_EXE: '/opt/genie', GENIE_LAUNCHER_HOST_BUILD: 'latest' })).toEqual({ launcherExe: '/opt/genie', hostBuild: null });
    });

    it('names exactly what the launcher hands its programs (native/launcher/src/control.rs and host.rs)', () => {
        expect(LAUNCHER_ENV).toEqual(['GENIE_LAUNCHER_EXE', 'GENIE_LAUNCHER_HOST_BUILD']);
        const control = readFileSync(join('native', 'launcher', 'src', 'control.rs'), 'utf8');
        for (const name of LAUNCHER_ENV) expect(control).toContain(`"${name}"`);
        expect(readFileSync(join('native', 'launcher', 'src', 'host.rs'), 'utf8')).toContain('"GENIE_LAUNCHER_EXE"');
    });

    it('none of it reaches an agent\'s processes (session-engine-server.ts\'s host-only names)', () => {
        const server = readFileSync(join('src', 'main', 'session-engine-server.ts'), 'utf8');
        const line = server.split('\n').find((l) => l.includes('const HOST_ONLY_ENV')) ?? '';
        for (const name of LAUNCHER_ENV) expect(line).toContain(`'${name}'`);
    });

    it('main.ts links a launched client to the launcher\'s host and makes no host copy for it', () => {
        const main = readFileSync(join('src', 'main', 'main.ts'), 'utf8');
        expect(main).toContain('launcherLink(process.env)');
        expect(main).toMatch(/launched\s*\?\s*\{[^}]*copied: false/);
    });
});

describe('where Genie finds the launcher\'s Windows modes (detach, job, pipe-owner-only)', () => {
    it('the launcher that started this process first: Genie.exe in the NSIS folder', () => {
        const launcher = 'C:\\Users\\a\\AppData\\Local\\Programs\\Genie\\Genie.exe';
        expect(winLauncherPath({ platform: 'win32', launcher, resources: ['C:\\x\\resources'], devRoot: 'C:\\dev', exists: () => true })).toBe(launcher);
    });
    it('then the single-app install\'s resources/bin/genie-launch.exe, as before', () => {
        expect(winLauncherPath({ platform: 'win32', launcher: null, resources: ['C:\\x\\resources'], devRoot: 'C:\\dev', exists: (p) => p.endsWith('genie-launch.exe') }))
            .toBe(join('C:\\x\\resources', 'bin', 'genie-launch.exe'));
    });
    it('a launcher that is not there is not used', () => {
        expect(winLauncherPath({ platform: 'win32', launcher: 'C:\\gone\\Genie.exe', resources: [], devRoot: 'C:\\dev', exists: () => false })).toBeNull();
    });
});
