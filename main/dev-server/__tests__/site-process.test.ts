import { describe, expect, it } from 'vitest';
import {
    startSiteProcess,
    stopSiteProcess,
    siteProcessAlive,
    readSiteProcessLog,
} from '../site-process';
import type { CommandResult, ContainerRuntime, ExecOptions } from '../container-runtime';

/**
 * A site is just a user command run as a DETACHED process inside the workspace
 * sandbox, in the repo's live-mounted dir. We track it by pidfile so we can stop
 * it (kill its whole process group) and report whether it's alive. The command is
 * passed as positional argv (never interpolated), so an arbitrary command can't
 * inject into the wrapper shell.
 */
function fakeRuntime(exec?: (argv: string[]) => CommandResult): {
    runtime: ContainerRuntime;
    execs: Array<{ id: string; argv: string[]; opts?: ExecOptions }>;
} {
    const execs: Array<{ id: string; argv: string[]; opts?: ExecOptions }> = [];
    const runtime = {
        async exec(id: string, argv: string[], opts?: ExecOptions) {
            execs.push({ id, argv, ...(opts ? { opts } : {}) });
            return exec ? exec(argv) : { code: 0, stdout: '', stderr: '' };
        },
    } as unknown as ContainerRuntime;
    return { runtime, execs };
}

const SID = 'abc123def456'; // a hex-ish site id

describe('startSiteProcess', () => {
    it('runs the command DETACHED (setsid) in the cwd and records its pid', async () => {
        const { runtime, execs } = fakeRuntime();
        const r = await startSiteProcess({
            runtime,
            containerId: 'sandbox-1',
            siteId: SID,
            command: ['npm', 'run', 'dev'],
            cwd: '/workspace/repos/app',
            env: { NODE_ENV: 'development' },
        });
        expect(r.ok).toBe(true);
        expect(execs).toHaveLength(1);
        const call = execs[0];
        const script = call.argv[2] ?? '';
        expect(script).toMatch(/setsid/); // detached in its own session/group
        expect(script).toContain(`${SID}.pid`); // pidfile keyed by site id
        expect(script).toMatch(/echo "\$!" >/); // records the group-leader pid
        // The command + cwd ride as POSITIONAL args, never spliced into the script.
        expect(call.argv.slice(3)).toEqual([
            'genie-site',
            '/workspace/repos/app',
            'npm',
            'run',
            'dev',
        ]);
        // The app's env is passed through.
        expect(call.opts?.env?.NODE_ENV).toBe('development');
    });

    it('refuses a non-hex site id rather than interpolate it into the shell', async () => {
        const { runtime, execs } = fakeRuntime();
        const r = await startSiteProcess({
            runtime,
            containerId: 'sandbox-1',
            siteId: 'no; rm -rf /',
            command: ['x'],
            cwd: '/workspace',
        });
        expect(r.ok).toBe(false);
        expect(execs).toHaveLength(0);
    });

    it('reports rather than throws when the command has nothing to run', async () => {
        const { runtime } = fakeRuntime();
        const r = await startSiteProcess({
            runtime,
            containerId: 'sandbox-1',
            siteId: SID,
            command: [],
            cwd: '/workspace',
        });
        expect(r.ok).toBe(false);
    });
});

describe('stopSiteProcess', () => {
    it('kills the whole process GROUP by the recorded pid (best-effort)', async () => {
        const { runtime, execs } = fakeRuntime();
        await stopSiteProcess(runtime, 'sandbox-1', SID);
        const script = execs[0]?.argv[2] ?? '';
        expect(script).toMatch(/kill .*-.*"?\$?/); // negative pid = the group
        expect(script).toContain(SID);
    });
});

describe('siteProcessAlive', () => {
    it('is true when kill -0 on the recorded pid succeeds', async () => {
        const { runtime } = fakeRuntime(() => ({ code: 0, stdout: '', stderr: '' }));
        expect(await siteProcessAlive(runtime, 'sandbox-1', SID)).toBe(true);
    });
    it('is false when the pid is gone', async () => {
        const { runtime } = fakeRuntime(() => ({ code: 1, stdout: '', stderr: '' }));
        expect(await siteProcessAlive(runtime, 'sandbox-1', SID)).toBe(false);
    });
});

describe('readSiteProcessLog', () => {
    it('tails the site log file keyed by the site id', async () => {
        const { runtime, execs } = fakeRuntime(() => ({
            code: 0,
            stdout: 'listening on 127.0.0.1:5173\n',
            stderr: '',
        }));
        const out = await readSiteProcessLog(runtime, 'sandbox-1', SID, 50);
        expect(out).toContain('listening on');
        const script = execs[0]?.argv[2] ?? '';
        expect(script).toContain(`${SID}.log`);
        expect(script).toContain('tail -n 50');
    });

    it('returns empty (never throws) for a bad site id', async () => {
        const { runtime, execs } = fakeRuntime();
        expect(await readSiteProcessLog(runtime, 'sandbox-1', 'no; rm -rf /')).toBe('');
        expect(execs).toHaveLength(0);
    });
});
