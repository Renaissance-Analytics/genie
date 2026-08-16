import { describe, expect, it, vi } from 'vitest';
import {
    installEngineVersion,
    planVersionInstall,
    planVersionRemoval,
    type VersionInstallEffects,
} from '../toolchain-version-install';
import type { EngineInstall } from '../toolchain-versions';

/**
 * Installing and removing ONE version of a language into Genie's own
 * `<userData>/toolchain/<lang>/<version>`.
 *
 * The plan is pure — the exact URL, the directory, the installer argv and the
 * `php.ini` are asserted with no network and no filesystem. The executor is
 * pure but for five injected effects, so the two rules that matter are provable:
 * **a pid is not proof it ran** (an install is only an install once the binary
 * answers from the directory Genie put it in), and **a failure leaves nothing
 * behind** (a half-unpacked version directory would look installed on the next
 * scan).
 */

const ROOT = 'C:\\g\\toolchain';
const WIN = { os: 'win32', arch: 'x64' };

function effects(over: Partial<VersionInstallEffects> = {}): VersionInstallEffects {
    return {
        download: vi.fn(async () => ({ ok: true as const, path: 'C:\\tmp\\a.zip' })),
        unpack: vi.fn(async () => ({ ok: true as const })),
        runInstaller: vi.fn(async () => ({ ok: true as const })),
        writeFile: vi.fn(async () => {}),
        verify: vi.fn(async () => ({ version: '8.3.33' })),
        removeDir: vi.fn(async () => {}),
        ...over,
    };
}

describe('planning an install', () => {
    it('refuses a version Genie has no recipe for — no free-text versions', () => {
        const plan = planVersionInstall('php', '8.9.9', WIN, ROOT);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/8\.9\.9/);
    });

    it('refuses a language Genie cannot install on THIS platform', () => {
        // php has official Windows builds and nothing relocatable elsewhere.
        expect(planVersionInstall('php', '8.3.33', { os: 'darwin' }, '/x').ok).toBe(false);
        expect(planVersionInstall('rust', '1.90.0', WIN, ROOT).ok).toBe(false);
    });

    it('lays php out under Genie\u2019s root with the real vendor URL', () => {
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.dir).toBe(`${ROOT}\\php\\8.3.33`);
        expect(plan.urls[0]).toBe(
            'https://windows.php.net/downloads/releases/php-8.3.33-nts-Win32-vs16-x64.zip',
        );
        // …and the archive fallback, because a superseded release MOVES.
        expect(plan.urls[1]).toContain('/archives/');
        expect(plan.artifact).toBe('zip');
        expect(plan.exe).toBe(`${ROOT}\\php\\8.3.33\\php.exe`);
    });

    it('writes a php.ini into the version directory — Genie owns the CONFIG too', () => {
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.configFile?.path).toBe(`${ROOT}\\php\\8.3.33\\php.ini`);
        expect(plan.configFile?.body).toContain('extension=mbstring');
        expect(plan.configFile?.body).toContain(`extension_dir = "${ROOT}\\php\\8.3.33\\ext"`);
    });

    it('gives node a config file of its own — there is none', () => {
        const plan = planVersionInstall('node', '24.19.0', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.configFile).toBeUndefined();
        // The Windows zip nests everything under one directory that is stripped.
        expect(plan.strip).toBe('node-v24.19.0-win-x64');
        expect(plan.exe).toBe(`${ROOT}\\node\\24.19.0\\node.exe`);
    });

    it('finds a posix engine under bin/', () => {
        const plan = planVersionInstall('go', '1.26.6', { os: 'linux', arch: 'x64' }, '/g/toolchain');
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.urls[0]).toBe('https://go.dev/dl/go1.26.6.linux-amd64.tar.gz');
        expect(plan.artifact).toBe('tar.gz');
        expect(plan.exe).toBe('/g/toolchain/go/1.26.6/bin/go');
    });

    it('substitutes the target directory into an installer\u2019s argv', () => {
        const plan = planVersionInstall('python', '3.13.15', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.artifact).toBe('exe');
        expect(plan.installerArgs).toContain(`TargetDir=${ROOT}\\python\\3.13.15`);
        // A per-user install: never elevate, never touch PATH, never take over
        // file associations for a runtime Genie resolves by path anyway.
        expect(plan.installerArgs).toContain('InstallAllUsers=0');
        expect(plan.installerArgs).toContain('PrependPath=0');
    });
});

describe('running an install', () => {
    it('downloads, unpacks, writes the config, then VERIFIES the binary answers', async () => {
        const e = effects();
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        const res = await installEngineVersion(plan, e);
        expect(res).toMatchObject({ ok: true, version: '8.3.33' });
        expect(e.download).toHaveBeenCalledWith(plan.urls);
        expect(e.unpack).toHaveBeenCalledWith({
            archive: 'C:\\tmp\\a.zip',
            artifact: 'zip',
            strip: '',
            dest: `${ROOT}\\php\\8.3.33`,
        });
        expect(e.writeFile).toHaveBeenCalledWith(plan.configFile!.path, plan.configFile!.body);
        expect(e.verify).toHaveBeenCalledWith(plan.exe);
    });

    it('runs the installer instead of unpacking, for an exe artifact', async () => {
        const e = effects({ verify: vi.fn(async () => ({ version: '3.13.15' })) });
        const plan = planVersionInstall('python', '3.13.15', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        expect((await installEngineVersion(plan, e)).ok).toBe(true);
        expect(e.unpack).not.toHaveBeenCalled();
        expect(e.runInstaller).toHaveBeenCalledWith('C:\\tmp\\a.zip', plan.installerArgs);
    });

    it('a pid is not proof it ran: an unpack that leaves no working binary FAILS', async () => {
        const e = effects({ verify: vi.fn(async () => ({})) });
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        const res = await installEngineVersion(plan, e);
        expect(res.ok).toBe(false);
        // …and the half-installed directory is GONE, or the next scan would list
        // a version that cannot run.
        expect(e.removeDir).toHaveBeenCalledWith(`${ROOT}\\php\\8.3.33`);
    });

    /**
     * WHY it did not run (genie#209 follow-up).
     *
     * The owner hit "PHP 8.4.24 unpacked, but …\php.exe did not run — nothing was
     * installed." and had nothing to act on: `verify` returned a version-or-
     * nothing, so the exit code and the binary's own words were thrown away. That
     * is the same blindness as genie#206, where the real cause sat in a log
     * nothing read. Verifying the explicit `plan.exe` stays — what changes is that
     * the failure now carries the reason, and tells three different stories for
     * three different bugs.
     */
    describe('when the binary does not answer, the failure says WHY', () => {
        const php = () => {
            const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
            if (!plan.ok) throw new Error('expected a plan');
            return plan;
        };

        it("carries the binary's own words into the failure", async () => {
            const e = effects({
                verify: vi.fn(async () => ({ detail: 'php.exe: Unable to initialize module' })),
            });
            const res = await installEngineVersion(php(), e);
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.error).toContain('Unable to initialize module');
        });

        it('names the Visual C++ redistributable when Windows could not START the process', async () => {
            // 0xC0000135 = STATUS_DLL_NOT_FOUND. windows.php.net builds import
            // vcruntime140.dll; on a machine without the redistributable the
            // process never starts and prints nothing at all, which is precisely
            // the clean-machine case and precisely the least self-explanatory one.
            const e = effects({
                verify: vi.fn(async () => ({ exitCode: 3221225781, detail: '' })),
            });
            const res = await installEngineVersion(php(), e);
            expect(res.ok).toBe(false);
            if (!res.ok) {
                expect(res.error).toMatch(/visual c\+\+/i);
                expect(res.error).toContain('vc_redist.x64.exe');
            }
        });

        it('says the binary is MISSING when it never landed, not that it would not run', async () => {
            // A layout/strip mismatch: the unpack "succeeded" and put the files
            // somewhere else. A different bug from a binary that cannot start, so
            // it gets a different sentence.
            const e = effects({ verify: vi.fn(async () => ({ missing: true })) });
            const res = await installEngineVersion(php(), e);
            expect(res.ok).toBe(false);
            if (!res.ok) {
                expect(res.error).toMatch(/not there|is missing|did not land/i);
                expect(res.error).not.toMatch(/did not run/i);
            }
        });
    });

    it('reports a failed download without leaving a directory behind', async () => {
        const e = effects({
            download: vi.fn(async () => ({ ok: false as const, error: 'HTTP 404' })),
        });
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        const res = await installEngineVersion(plan, e);
        expect(res).toMatchObject({ ok: false });
        if (!res.ok) expect(res.error).toContain('HTTP 404');
        expect(e.unpack).not.toHaveBeenCalled();
        expect(e.removeDir).toHaveBeenCalledWith(`${ROOT}\\php\\8.3.33`);
    });

    it('never throws, even when an effect does', async () => {
        const e = effects({
            unpack: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const plan = planVersionInstall('php', '8.3.33', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        const res = await installEngineVersion(plan, e);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('disk full');
    });
});

describe('removing a version', () => {
    const genie = (version: string): EngineInstall => ({
        tool: 'php',
        version,
        dir: `${ROOT}\\php\\${version}`,
        exe: `${ROOT}\\php\\${version}\\php.exe`,
        source: 'genie',
        removable: true,
        sizeBytes: 90_000_000,
    });
    const herd: EngineInstall = {
        tool: 'php',
        version: '8.4.1',
        dir: 'C:\\Users\\x\\.config\\herd\\bin\\php84',
        exe: 'C:\\Users\\x\\.config\\herd\\bin\\php84\\php.exe',
        source: 'herd',
        removable: false,
    };

    it('refuses to delete another app\u2019s install', () => {
        const plan = planVersionRemoval(herd, [herd], {});
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/Herd/);
    });

    it('deletes the version DIRECTORY — which is what reclaims the disk', () => {
        const plan = planVersionRemoval(genie('8.2.33'), [genie('8.3.33'), genie('8.2.33')], {
            php: '8.3.33',
        });
        expect(plan).toMatchObject({
            ok: true,
            dir: `${ROOT}\\php\\8.2.33`,
            freedBytes: 90_000_000,
        });
    });

    it('moves the default when the version being removed IS the default', () => {
        const plan = planVersionRemoval(genie('8.3.33'), [genie('8.3.33'), genie('8.2.33')], {
            php: '8.3.33',
        });
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.nextDefault).toBe('8.2.33');
    });

    it('clears the default when the last Genie version goes', () => {
        const plan = planVersionRemoval(genie('8.3.33'), [genie('8.3.33'), herd], {
            php: '8.3.33',
        });
        if (!plan.ok) throw new Error('expected a plan');
        // NOT Herd's 8.4.1 — an unmanaged install is never promoted to default.
        expect(plan.nextDefault).toBeNull();
    });

    it('leaves an unrelated default alone', () => {
        const plan = planVersionRemoval(genie('8.2.33'), [genie('8.3.33'), genie('8.2.33')], {
            php: '8.3.33',
        });
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.nextDefault).toBeUndefined();
    });
});
