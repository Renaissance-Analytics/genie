import { app } from 'electron';
import { join } from 'node:path';
import { realElectronUpdaterPort } from './electron-updater-port.js';
import { linkToRunningHost, pidAlive, spawnGenieWindow } from './engine-launch.js';
import { genieRoot, runtimeDir } from './paths.js';
import { listProcessesAsync } from './process-list.js';
import { connectUpdaterLink, runUpdaterHelper } from './updater-helper.js';
import { relaunchSpec, writeUpdateFailed } from './updates-host.js';

/**
 * THE UPDATER HELPER (the host split, P5b). `--updater` (core/entry-mode.ts), started by genie-host, detached, when a check,
 * a download or an install needs electron-updater — which needs Electron's `app`, which the host (Electron as Node) has
 * not. It links to the running host with the host's token (never starts or replaces one), and makes the library's calls
 * the host asks for. No window, no agent, no site. The rules are updater-helper.ts's.
 *
 * Its own user data folder, under the runtime folder, and its own single-instance lock: `Genie.exe --updater` never
 * collides with the window's lock or its Chromium profile (the browser process's rule, P2b).
 */

const home = genieRoot();
app.setPath('userData', join(runtimeDir(home), '.updater'));
const log = (line: string): void => { console.log(`[genie-updater] ${new Date().toISOString()} ${line}`); };

async function runUpdaterProcess(): Promise<void> {
    if (!app.requestSingleInstanceLock()) { log('another updater is running; this one leaves'); app.exit(0); return; }
    // No window ever opens here: nothing closing one may end it, and nothing but the helper's own rules end it.
    app.on('window-all-closed', () => {});
    await app.whenReady();
    runUpdaterHelper({
        link: async () => {
            const found = await linkToRunningHost({ runtimeDir: runtimeDir(home) });
            if (found === null) return null;
            const client = await connectUpdaterLink(found.transport, found.token);
            if (client === null) found.transport.close();
            return client;
        },
        port: realElectronUpdaterPort(),
        pid: process.pid,
        processes: () => listProcessesAsync(),
        alive: pidAlive,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        quit: () => { app.quit(); },
        recordFailure: (reason) => { writeUpdateFailed(home, { at: Date.now(), reason, log: join(home, 'logs', 'genie-updater.log') }); },
        // This executable as the window started it (a dev run's app path, its switches), without the updater mode.
        relaunch: () => { spawnGenieWindow(relaunchSpec({ file: process.execPath, args: process.argv.slice(1) }, process.env), process.env); },
        log,
    });
}

void runUpdaterProcess();
