import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '@particle-academy/fancy-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * BOOT FROZE BEHIND AN INVISIBLE ERROR BOX — the fancy-pty Genie RESOLVES must hear a write to a helper that is gone.
 *
 * Measured on the installed app in genie-test-ubuntu (2026-10-15, the services acceptance seed): 3 s into boot the front
 * door's Caddy could not bind its port, printed so, and exited. compose.ts's bind-failure watcher (`supervisor.onOutput`
 * → `supervisor.stop(FRONT_DOOR_ID)`) asked for the stop in the same tick, before fancy-pty had processed the Exit frame or
 * `close`, so fancy-pty's `send` wrote the Kill frame into a dead pipe. Node raised that EPIPE as an `error` event on the
 * helper's stdin, which had no listener: an uncaught exception in Electron's main process, whose default handler is a
 * synchronous GTK dialog (gdb: `__GI___poll` ← `g_main_loop_run` ← `gtk_dialog_run`). From then on the main thread ran
 * no JavaScript (the Node inspector's Debugger.enable went unanswered), DevTools' /json/list timed out, and nothing Genie
 * supervises was looked after — for as long as the box stayed unclicked, which under Xvfb is forever.
 *
 * The cure is in fancy-pty (`child.stdin.on('error', …)`, Fancy's repo). This test holds GENIE to it: it runs against the
 * fancy-pty that genie2's lockfile resolves, so it is red until the lock carries the fixed release, and goes red again if
 * a lock change ever resolves one without it.
 *
 * Fixture: a helper that closes its stdin at once and stays alive for a second — "the reader is gone, `close` has not
 * fired", deterministically. POSIX only (genie CI and the Linux VM). A CONTROL first shows the fixture really answers a
 * write with EPIPE, so "no uncaught exception" is never read off a run where nothing failed.
 */

const posix = process.platform !== 'win32';
let dir = '';
let helper = '';
const uncaught: Error[] = [];
const onUncaught = (e: Error) => { uncaught.push(e); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genie-pty-epipe-'));
    helper = join(dir, 'gone-helper.sh');
    writeFileSync(helper, '#!/bin/sh\nexec 0<&-\nsleep 1\nexit 0\n');
    chmodSync(helper, 0o755);
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
});

afterEach(() => {
    process.off('uncaughtException', onUncaught);
    rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('a stop that races the helper going (the front door at boot)', () => {
    it('CONTROL: the fixture answers a write with EPIPE', async () => {
        const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        const codes: string[] = [];
        child.stdin.on('error', (e: NodeJS.ErrnoException) => codes.push(e.code ?? e.message));
        await sleep(200);
        child.stdin.write(Buffer.from('anything'));
        await new Promise<void>((r) => child.on('close', () => r()));
        expect(codes).toEqual(['EPIPE']);
    });

    it('kill() into the dead pipe raises no uncaught exception, and the exit is still reported', async () => {
        const pty = open({ argv: ['irrelevant'], helper });
        pty.onError(() => { /* the helper's going is reported here; the EPIPE must not be thrown anywhere */ });
        const exited = new Promise<number>((r) => pty.onExit(r));
        await sleep(200);
        expect(pty.exited).toBe(false); // the state ProcessSupervisor.stop met
        pty.kill();
        const code = await exited;
        await sleep(50);
        expect(uncaught.map((e) => e.message)).toEqual([]);
        expect(typeof code).toBe('number');
    });
});
