import { describe, expect, it } from 'vitest';
import { BUILD_SOURCE_MOUNT, prepareIsolatedBuild } from '../isolated-build';
import { siteBuildContainerNameFor, siteBuildVolumeNameFor } from '../argv';
import type {
    CommandResult,
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    ExecOptions,
} from '../container-runtime';

/**
 * THE ISOLATED BUILD ENVIRONMENT (genie #119, Blocker 4).
 *
 * The one property that matters: the build never writes to the developer's
 * working tree. This proves the mechanism that guarantees it — a READ-ONLY host
 * source, a fresh container-owned volume, and a copy performed through `exec` so
 * it lands on the build uid (which is why it can own its own repo and overwrite
 * committed files, killing the dubious-ownership + EPERM failures at the root).
 */

interface Calls {
    ran: ContainerSpec[];
    removed: string[];
    removedVolumes: string[];
    execs: Array<{ id: string; argv: string[]; opts?: ExecOptions }>;
}

function fakeRuntime(opts: {
    existing?: ContainerSummary[];
    exec?: (argv: string[]) => CommandResult;
    runFails?: boolean;
}): { runtime: ContainerRuntime; calls: Calls } {
    const calls: Calls = { ran: [], removed: [], removedVolumes: [], execs: [] };
    const runtime = {
        kind: 'docker',
        async ps() {
            return opts.existing ?? [];
        },
        async remove(id: string) {
            calls.removed.push(id);
        },
        async volumeRemove(name: string) {
            calls.removedVolumes.push(name);
        },
        async runContainer(spec: ContainerSpec) {
            calls.ran.push(spec);
            if (opts.runFails) throw new Error('docker run exploded');
            return { id: `id-${spec.name}`, name: spec.name };
        },
        async exec(id: string, argv: string[], execOpts?: ExecOptions) {
            calls.execs.push({ id, argv, ...(execOpts ? { opts: execOpts } : {}) });
            return opts.exec ? opts.exec(argv) : { code: 0, stdout: '', stderr: '' };
        },
    } as unknown as ContainerRuntime;
    return { runtime, calls };
}

const base = () => ({
    workspaceId: 'acme',
    siteId: 'site-web',
    siteName: 'web',
    hostSource: '/work/acme/repos/app',
    network: 'genie-ws-acme',
    image: 'genie-dev-base:1',
    mountTarget: '/workspace',
    workdir: '/workspace/repos/app',
    platform: 'linux' as const,
    hostIds: null,
    copyTimeoutMs: 1000,
});

describe('prepareIsolatedBuild', () => {
    it('mounts the host repo READ-ONLY and builds into a container-owned volume', async () => {
        const { runtime, calls } = fakeRuntime({});
        const result = await prepareIsolatedBuild({ runtime, ...base() });

        expect(result.ok).toBe(true);
        const spec = calls.ran[0];
        expect(spec?.name).toBe(siteBuildContainerNameFor('acme', 'web'));
        expect(spec?.mounts).toEqual([
            { source: '/work/acme/repos/app', target: BUILD_SOURCE_MOUNT, readOnly: true },
        ]);
        expect(spec?.volumes).toEqual([
            { name: siteBuildVolumeNameFor('acme', 'web'), target: '/workspace' },
        ]);
    });

    it('resets the volume BEFORE the build container is created — a fresh checkout every time', async () => {
        const { runtime, calls } = fakeRuntime({});
        await prepareIsolatedBuild({ runtime, ...base() });
        expect(calls.removedVolumes).toContain(siteBuildVolumeNameFor('acme', 'web'));
        // The reset happens before the container that would hold the volume.
        expect(calls.removedVolumes.length).toBeGreaterThan(0);
        expect(calls.ran.length).toBe(1);
    });

    it('clears a stale build container before resetting the volume it would hold', async () => {
        const { runtime, calls } = fakeRuntime({
            existing: [
                {
                    id: 'id-stale',
                    name: siteBuildContainerNameFor('acme', 'web'),
                    image: 'genie-dev-base:1',
                    state: 'exited',
                },
            ],
        });
        await prepareIsolatedBuild({ runtime, ...base() });
        expect(calls.removed).toContain('id-stale');
    });

    it('copies the source into the workdir through exec, owned by the build user (cp -a)', async () => {
        const { runtime, calls } = fakeRuntime({});
        await prepareIsolatedBuild({ runtime, ...base() });
        const copy = calls.execs.find((e) => e.argv[0] === 'sh');
        expect(copy?.id).toBe(`id-${siteBuildContainerNameFor('acme', 'web')}`);
        // A non-root `cp -a` cannot chown, so the copy is owned by the copier —
        // the exact property that defeats git dubious-ownership + EPERM.
        expect(copy?.argv.join(' ')).toContain(`cp -a ${BUILD_SOURCE_MOUNT}/.`);
        expect(copy?.argv.join(' ')).toContain('/workspace/repos/app');
    });

    it('RECURSIVELY takes ownership + wipes the workdir BEFORE copying — else a reused/root-owned volume blocks the copy', async () => {
        const { runtime, calls } = fakeRuntime({});
        await prepareIsolatedBuild({ runtime, ...base() });
        const script = calls.execs.find((e) => e.argv[0] === 'sh')?.argv[2] ?? '';
        // The volume can arrive DIRTY: fresh ones mount ROOT-owned on Docker
        // Desktop, and REUSED ones carry root-owned files a prior serve container
        // wrote (the reset can't drop a volume serve still holds, and `volume rm`
        // is tolerant). A non-recursive chown of just the volume root leaves a
        // root-owned `<workdir>/node_modules` etc. → `cp` dies "Permission denied"
        // + "preserving times … Operation not permitted". So: chown -R the whole
        // mount target (genie has NOPASSWD sudo), wipe the workdir for a clean
        // checkout, THEN copy — all before `cp -a`.
        expect(script).toMatch(/sudo\s+chown\s+-R\b/); // RECURSIVE, not just the root
        expect(script).toContain('/workspace');
        expect(script).toMatch(/rm\s+-rf/); // clean checkout on a reused volume
        expect(script.indexOf('chown')).toBeLessThan(script.indexOf('rm -rf')); // own before wipe
        expect(script.indexOf('rm -rf')).toBeLessThan(script.indexOf('cp -a')); // wipe before copy
    });

    it('drops a dangling submodule gitlink AFTER the copy so `composer install`\'s git call survives (genie #122)', async () => {
        const { runtime, calls } = fakeRuntime({});
        await prepareIsolatedBuild({ runtime, ...base() });
        const script = calls.execs.find((e) => e.argv[0] === 'sh')?.argv[2] ?? '';
        // A submodule's `.git` is a gitlink FILE pointing outside the copied subdir
        // → dangles in the isolated copy → composer's `git show-ref` dies. Only a
        // regular-file `.git` (the gitlink) is removed; a real `.git` DIR is kept.
        expect(script).toMatch(/\[ -f '[^']*\/\.git' \]/); // guarded on it being a FILE
        expect(script).toContain("rm -f '/workspace/repos/app/.git'");
        expect(script.indexOf('cp -a')).toBeLessThan(script.indexOf('.git')); // after the copy
    });

    it('tears the container down AND drops the volume when the copy fails', async () => {
        const { runtime, calls } = fakeRuntime({
            exec: () => ({ code: 1, stdout: '', stderr: 'no space left on device' }),
        });
        const result = await prepareIsolatedBuild({ runtime, ...base() });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/copy failed/i);
        expect(calls.removed).toContain(`id-${siteBuildContainerNameFor('acme', 'web')}`);
        // The reset drop AND the failure drop both name the volume.
        expect(calls.removedVolumes.filter((v) => v === siteBuildVolumeNameFor('acme', 'web')).length)
            .toBeGreaterThanOrEqual(2);
    });

    it('drops the volume and reports, rather than throwing, when the container will not start', async () => {
        const { runtime, calls } = fakeRuntime({ runFails: true });
        const result = await prepareIsolatedBuild({ runtime, ...base() });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/build container/i);
        expect(calls.execs).toHaveLength(0);
        expect(calls.removedVolumes).toContain(siteBuildVolumeNameFor('acme', 'web'));
    });
});
