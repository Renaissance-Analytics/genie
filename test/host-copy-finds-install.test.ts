import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updaterDefaultLaunch } from '../src/main/updates-host.js';

/**
 * THE HOST RUNS FROM ITS COPY; THE UPDATER STILL STARTS FROM THE INSTALL (#1545 with P5b). With the host materialized under
 * `<home>/host/runtime-<electron>/`, its own `process.execPath` is the COPY. The updater helper it starts must be the
 * INSTALLED Genie, never the copy: electron-updater installs over the app it runs from. The window, which runs from the
 * install, hands its executable to the host (GENIE_INSTALL_EXEC); the host's default helper launch uses it.
 */
const install = resolve('/', 'opt', 'Genie', 'genie');
const copy = resolve('/', 'home', 'u', '.genie', 'host', 'runtime-45.2.3', 'genie');

describe('the updater helper starts from the install when the host runs from its copy', () => {
    it('the install the window named, not the host’s own (copied) executable', () => {
        expect(updaterDefaultLaunch({ GENIE_INSTALL_EXEC: install }, copy)).toEqual({ file: install, args: ['--updater'] });
    });

    it('CONTROL: with no install named (a host started in place, a dev run), its own executable, as before', () => {
        expect(updaterDefaultLaunch({}, install)).toEqual({ file: install, args: ['--updater'] });
    });

    it('wired: the window names its executable to the host, and the host’s default helper launch reads it', () => {
        const main = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(main).toMatch(/GENIE_RESOURCES: process\.resourcesPath, GENIE_INSTALL_EXEC: process\.execPath \}/);
        const host = readFileSync('src/main/genie-host.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(host).toMatch(/defaultLaunch: updaterDefaultLaunch\(process\.env, process\.execPath\)/);
    });
});
