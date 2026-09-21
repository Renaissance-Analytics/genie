import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCodexAppServer, tokenForTerminal } from '../codex-app-server-lifecycle';

/**
 * A RUNNING APP-SERVER'S TOKEN MUST NOT BE REPLACED UNDER IT (genie, from
 * claude:fancy's investigation).
 *
 * Symptom, measured on a real machine: a codex TUI connects to the CORRECT,
 * current, live app-server and is refused with `401 Unauthorized`. Every value
 * looked right — the shell's `GENIE_CODEX_APP_TOKEN`, the token file, and the
 * `--ws-token-file` path on the server's own command line all matched.
 *
 * They matched because they were all the NEW token. The server was still using
 * the old one:
 *
 *   - `createAgentTerminal` always calls `prepareCodexAppServer`, which mints a
 *     fresh token and OVERWRITES `<terminalId>.token`, then puts it in the new
 *     pty's env;
 *   - `CodexAppServerManager.start()` returns early when a server already
 *     exists for that terminal — discarding the `prepared` it was handed.
 *
 * So a surviving app-server authenticates with token A while the file and the
 * shell both hold token B. Nothing looks stale, which is why it took a process
 * watcher and three measurements to find.
 *
 * The invariant these pin: for one terminal, the token in the file is the token
 * the caller was given. A second preparation for the same terminal must not
 * silently invalidate the first while something is still using it.
 */
describe('prepareCodexAppServer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-'));

    it('writes the token it returns', () => {
        const prepared = prepareCodexAppServer('t-write', dir);
        expect(fs.readFileSync(prepared.tokenFile, 'utf8').trim()).toBe(prepared.token);
    });

    it('MINTS A DIFFERENT TOKEN on a second call for the SAME terminal', () => {
        // Not a bug on its own — this documents the behaviour that becomes one
        // when a server is already running against the first token. If this ever
        // changes to "reuse", the guard above it can be simplified; until then
        // the caller must not call this while a server is live.
        const first = prepareCodexAppServer('t-twice', dir);
        const second = prepareCodexAppServer('t-twice', dir);

        expect(second.token).not.toBe(first.token);
        expect(second.tokenFile).toBe(first.tokenFile);
        // And the file now holds ONLY the second — the first is unrecoverable,
        // which is precisely what stranded the running server.
        expect(fs.readFileSync(first.tokenFile, 'utf8').trim()).toBe(second.token);
        expect(fs.readFileSync(first.tokenFile, 'utf8').trim()).not.toBe(first.token);
    });
});

describe('tokenForTerminal — which token the TUI is given', () => {
    const mintCalls: number[] = [];
    const mint = () => {
        mintCalls.push(1);
        return { token: 'fresh', tokenFile: '/tmp/fresh.token' };
    };

    it('REUSES the running server\'s token instead of minting', () => {
        mintCalls.length = 0;
        const running = { token: 'the-one-the-server-loaded', tokenFile: '/tmp/t.token' };

        const chosen = tokenForTerminal(running, mint);

        expect(chosen.token).toBe('the-one-the-server-loaded');
        // And it must not mint as a side effect — minting WRITES the file, which
        // is what overwrote the running server's credential in the first place.
        expect(mintCalls).toHaveLength(0);
    });

    it('mints when nothing is running', () => {
        // POSITIVE CONTROL: the mint path has to still be reachable, or a
        // first-ever launch would have no token at all.
        mintCalls.length = 0;

        const chosen = tokenForTerminal(undefined, mint);

        expect(chosen.token).toBe('fresh');
        expect(mintCalls).toHaveLength(1);
    });
});
