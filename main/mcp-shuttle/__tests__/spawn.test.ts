import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnShuttleProcess } from '../spawn';

/**
 * STARTING THE SHUTTLE PROCESS, AND LEARNING HOW IT WENT.
 *
 * genie#346 Phase 1, §3.3. The shuttle is spawned DETACHED so it outlives Genie, and
 * a detached child that still writes into its parent's pipes dies of EPIPE the
 * moment the parent does. So its output goes to a log file, and the one thing
 * Genie needs back — started, refused, or broken — arrives over an IPC message the
 * child sends once and then disconnects. These run real child processes on the
 * test's own Node, from tiny scripts standing in for the bundle.
 */

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
    for (const pid of pids.splice(0)) {
        try {
            process.kill(pid);
        } catch {
            /* already gone */
        }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function script(body: string): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-spawn-'));
    dirs.push(dir);
    const file = path.join(dir, 'shuttle.cjs');
    fs.writeFileSync(file, body);
    return { dir, file };
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe('spawnShuttleProcess', () => {
    it('reports STARTED from the child’s message, and leaves the child running on its own', async () => {
        const { dir, file } = script(`
            process.send({ event: 'started', pid: process.pid, port: 1, controlPath: 'x' }, () => process.disconnect());
            setInterval(() => {}, 1000);
        `);

        const outcome = await spawnShuttleProcess({
            nodePath: process.execPath,
            scriptPath: file,
            env: {},
            logFile: path.join(dir, 'shuttle.log'),
        });

        expect(outcome.kind).toBe('started');
        if (outcome.kind !== 'started') return;
        pids.push(outcome.pid);
        expect(alive(outcome.pid)).toBe(true);
    });

    it('reports a REFUSAL with its reason', async () => {
        const { dir, file } = script(`
            process.send({ event: 'refused', reason: 'port-in-use', error: 'Port 51717 is already in use.' }, () => process.exit(3));
        `);

        const outcome = await spawnShuttleProcess({
            nodePath: process.execPath,
            scriptPath: file,
            env: {},
            logFile: path.join(dir, 'shuttle.log'),
        });

        expect(outcome).toEqual({ kind: 'refused', reason: 'port-in-use', error: 'Port 51717 is already in use.' });
    });

    it('reports a child that exits WITHOUT a word, pointing at its log', async () => {
        const { dir, file } = script(`console.error('boom: cannot find module'); process.exit(1);`);
        const logFile = path.join(dir, 'shuttle.log');

        const outcome = await spawnShuttleProcess({ nodePath: process.execPath, scriptPath: file, env: {}, logFile });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') return;
        expect(outcome.error).toContain('exited');
        expect(outcome.error).toContain(logFile);
        // Its output went to the log, not to a pipe that could kill it later.
        expect(fs.readFileSync(logFile, 'utf8')).toContain('boom: cannot find module');
    });

    it('gives up on a child that says nothing, and stops it', async () => {
        const { dir, file } = script(`
            require('fs').writeFileSync(require('path').join(__dirname, 'pid'), String(process.pid));
            setInterval(() => {}, 1000);
        `);

        const outcome = await spawnShuttleProcess({
            nodePath: process.execPath,
            scriptPath: file,
            env: {},
            logFile: path.join(dir, 'shuttle.log'),
            timeoutMs: 1_000,
        });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') return;
        expect(outcome.error).toContain('1000ms');
        // A silent shuttle left running would hold the pipe and the port, and
        // make every later attempt this boot refuse.
        const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
        pids.push(pid);
        const deadline = Date.now() + 3_000;
        while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        expect(alive(pid)).toBe(false);
    });

    it('does not give up on a report that ARRIVED while the loop was busy', async () => {
        // The same trap as the welcome: a timer that fires when the loop comes
        // back from a long boot, before the message already waiting behind it.
        const { dir, file } = script(`
            process.send({ event: 'refused', reason: 'port-in-use', error: 'taken' }, () => process.exit(3));
        `);

        const pending = spawnShuttleProcess({
            nodePath: process.execPath,
            scriptPath: file,
            env: {},
            logFile: path.join(dir, 'shuttle.log'),
            timeoutMs: 400,
        });
        // Held from the CHECK phase — long enough for the child to start and report,
        // and past the deadline — so the next loop iteration begins at the timers.
        await new Promise((r) => setTimeout(r, 5));
        await new Promise<void>((r) =>
            setImmediate(() => {
                const until = Date.now() + 2_500;
                while (Date.now() < until) {
                    /* busy */
                }
                r();
            }),
        );

        expect(await pending).toMatchObject({ kind: 'refused', reason: 'port-in-use' });
    });

    it('reports a runtime that does not exist rather than throwing', async () => {
        const { dir, file } = script('');

        const outcome = await spawnShuttleProcess({
            nodePath: path.join(dir, 'no-such-node'),
            scriptPath: file,
            env: {},
            logFile: path.join(dir, 'shuttle.log'),
        });

        expect(outcome.kind).toBe('failed');
    });

    it('passes the environment it is given', async () => {
        const { dir, file } = script(`
            process.send({ event: 'refused', reason: 'echo', error: String(process.env.GENIE_SHUTTLE_PORT) }, () => process.exit(3));
        `);

        const outcome = await spawnShuttleProcess({
            nodePath: process.execPath,
            scriptPath: file,
            env: { GENIE_SHUTTLE_PORT: '4242' },
            logFile: path.join(dir, 'shuttle.log'),
        });

        expect(outcome).toMatchObject({ kind: 'refused', error: '4242' });
    });
});
