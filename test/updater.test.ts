import { describe, expect, it } from 'vitest';
import { UpdateHost, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import { updaterChannel, type RunningProcess } from '../src/main/upgrade.js';

/**
 * THE UPDATER — §7, and §0.8: "the updater could never see a release".
 *
 * `electron-updater` was configured (`updaterChannel`) and never WIRED: nothing called
 * `checkForUpdates`, so "check for updates" could not run at all. This host is the wiring, with
 * the library behind a port so every rule below is proved without a network, a feed or an
 * installer:
 *
 *   - the channel settings reach the library exactly once, as the pair the config test pins;
 *   - a check reports `available <version>` or `none`, and NOTHING downloads by itself;
 *   - a second check while one is in flight is rejoined, not duplicated;
 *   - download is refused before anything is available; install is refused before anything
 *     is downloaded — refusals are return values, never silent no-ops;
 *   - §7.2: before applying, every process running from the install directory is terminated —
 *     and ONLY those: not our own process, not a sibling install — and the report names them;
 *   - an error is a phase with its message, and the next check clears it.
 *
 * Counts, not booleans, wherever a boolean would pass on a host that did nothing.
 */

interface Fake {
    port: UpdaterPort;
    configured: Array<{ allowPrerelease: boolean; autoDownload: boolean }>;
    checks: number;
    downloads: number;
    installs: number;
    /** What the next check answers. */
    answer: { version: string } | null | Error;
    /** Set while a check is pending so the test can control when it resolves. */
    resolveCheck: (() => void) | null;
    progress: ((percent: number) => void) | null;
    finishDownload: (() => void) | null;
}

function fakePort(answer: Fake['answer'] = null): Fake {
    const fake: Fake = {
        configured: [],
        checks: 0,
        downloads: 0,
        installs: 0,
        answer,
        resolveCheck: null,
        progress: null,
        finishDownload: null,
        port: {
            configure: (channel) => { fake.configured.push({ ...channel }); },
            check: () => new Promise((resolve, reject) => {
                fake.checks += 1;
                fake.resolveCheck = () => {
                    fake.resolveCheck = null;
                    if (fake.answer instanceof Error) reject(fake.answer);
                    else resolve(fake.answer);
                };
            }),
            download: (onProgress) => new Promise((resolve) => {
                fake.downloads += 1;
                fake.progress = onProgress;
                fake.finishDownload = () => { fake.finishDownload = null; resolve(); };
            }),
            quitAndInstall: () => { fake.installs += 1; },
        },
    };
    return fake;
}

const INSTALL = 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie';
const OWN_PID = 4100;

function host(fake: Fake, processes: RunningProcess[] = []) {
    const killed: number[] = [];
    const changes: UpdateState[] = [];
    const h = new UpdateHost({
        port: fake.port,
        installDir: INSTALL,
        ownPid: OWN_PID,
        processes: () => processes,
        kill: (pid) => { killed.push(pid); return true; },
        clock: () => 1_700_000_000_000,
        caseInsensitive: true,
    });
    h.onChange((s) => { changes.push(s); });
    return { h, killed, changes };
}

async function settle() {
    await new Promise((r) => setTimeout(r, 0));
}

describe('channel', () => {
    it('hands the library the channel pair exactly once, as the config test pins it', () => {
        const fake = fakePort();
        host(fake);
        expect(fake.configured).toHaveLength(1);
        expect(fake.configured[0]).toEqual({
            allowPrerelease: updaterChannel.allowPrerelease,
            autoDownload: updaterChannel.autoDownload,
        });
        expect(fake.configured[0]!.allowPrerelease).toBe(true);
        expect(fake.configured[0]!.autoDownload).toBe(false);
    });

    it('starts idle, knowing nothing — every field null, not zero', () => {
        const { h } = host(fakePort());
        expect(h.state()).toEqual({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null });
    });
});

describe('check', () => {
    it('reports an available version, and downloads NOTHING on its own', async () => {
        const fake = fakePort({ version: '0.0.1' });
        const { h } = host(fake);
        const p = h.check();
        expect(h.state().phase).toBe('checking');
        fake.resolveCheck!();
        await p;
        expect(h.state()).toMatchObject({ phase: 'available', version: '0.0.1', checkedAt: 1_700_000_000_000 });
        expect(fake.downloads).toBe(0);
    });

    it('reports none as none — a fact, not an empty version', async () => {
        const fake = fakePort(null);
        const { h } = host(fake);
        const p = h.check();
        fake.resolveCheck!();
        await p;
        expect(h.state()).toMatchObject({ phase: 'none', version: null, checkedAt: 1_700_000_000_000 });
    });

    it('rejoins a check already in flight instead of asking the library twice', async () => {
        const fake = fakePort({ version: '0.0.2' });
        const { h } = host(fake);
        const a = h.check();
        const b = h.check();
        expect(fake.checks).toBe(1);
        fake.resolveCheck!();
        await Promise.all([a, b]);
        expect(fake.checks).toBe(1);
        expect(h.state().version).toBe('0.0.2');
    });

    it('turns a library error into an error phase with its message, and the next check clears it', async () => {
        const fake = fakePort(new Error('ENOTFOUND feed.example'));
        const { h } = host(fake);
        const p = h.check();
        fake.resolveCheck!();
        await p;
        expect(h.state()).toMatchObject({ phase: 'error', error: 'ENOTFOUND feed.example', version: null });

        fake.answer = null;
        const q = h.check();
        expect(h.state().error).toBeNull();
        fake.resolveCheck!();
        await q;
        expect(h.state().phase).toBe('none');
    });
});

describe('download', () => {
    it('is refused before anything is available — a return value, and the library is not asked', async () => {
        const fake = fakePort();
        const { h } = host(fake);
        expect(await h.download()).toBe(false);
        expect(fake.downloads).toBe(0);
        expect(h.state().phase).toBe('idle');
    });

    it('streams progress into the state and lands on downloaded', async () => {
        const fake = fakePort({ version: '0.0.1' });
        const { h, changes } = host(fake);
        const c = h.check(); fake.resolveCheck!(); await c;
        const before = changes.length;

        const d = h.download();
        await settle();
        expect(h.state().phase).toBe('downloading');
        fake.progress!(12.5);
        fake.progress!(80);
        expect(h.state().percent).toBe(80);
        fake.finishDownload!();
        expect(await d).toBe(true);
        expect(h.state()).toMatchObject({ phase: 'downloaded', version: '0.0.1', percent: 100 });
        // downloading + two progress ticks + downloaded = four changes, each one observable
        expect(changes.length - before).toBe(4);
        expect(fake.downloads).toBe(1);
    });
});

describe('install — §7.2 teardown first', () => {
    const procs: RunningProcess[] = [
        { pid: OWN_PID, executable: `${INSTALL}\\Genie.exe` },                                   // us — never
        { pid: 5001, executable: `${INSTALL}\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\conpty\\OpenConsole.exe` },
        { pid: 5002, executable: `${INSTALL.toLowerCase()}\\genie.exe` },                        // case-folded, Windows
        { pid: 6001, executable: 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie2\\Genie.exe' }, // sibling install — never
        { pid: 7001, executable: 'C:\\Windows\\System32\\svchost.exe' },
    ];

    async function downloaded() {
        const fake = fakePort({ version: '0.0.1' });
        const made = host(fake, procs);
        const c = made.h.check(); fake.resolveCheck!(); await c;
        const d = made.h.download(); await settle(); fake.finishDownload!(); await d;
        return { fake, ...made };
    }

    it('is refused before anything is downloaded — nothing is killed, the library is not asked', async () => {
        const fake = fakePort({ version: '0.0.1' });
        const { h, killed } = host(fake, procs);
        expect(h.install()).toBeNull();
        const c = h.check(); fake.resolveCheck!(); await c;
        expect(h.install()).toBeNull();
        expect(killed).toEqual([]);
        expect(fake.installs).toBe(0);
    });

    it('terminates exactly the processes under the install directory, then asks the library to install', async () => {
        const { h, killed, fake } = await downloaded();
        const result = h.install();
        expect(result).not.toBeNull();
        expect(killed.sort()).toEqual([5001, 5002]);
        expect(result!.killed.map((p) => p.pid).sort()).toEqual([5001, 5002]);
        expect(fake.installs).toBe(1);
        expect(h.state().phase).toBe('installing');
    });

    it('reports what was killed, by pid and path, and says so when it was nothing', async () => {
        const { h } = await downloaded();
        const report = h.install()!.report;
        expect(report).toContain('2 processes were running from the install directory');
        expect(report).toContain('5001 ');
        expect(report).toContain('OpenConsole.exe');
        expect(report).not.toContain('6001');
        expect(report).not.toContain(String(OWN_PID));

        const fake = fakePort({ version: '0.0.1' });
        const { h: quiet } = host(fake, []);
        const c = quiet.check(); fake.resolveCheck!(); await c;
        const d = quiet.download(); await settle(); fake.finishDownload!(); await d;
        expect(quiet.install()!.report).toBe('No processes were running from the install directory.');
    });
});
