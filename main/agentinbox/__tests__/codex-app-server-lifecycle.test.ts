import { describe, expect, it } from 'vitest';
import {
    codexAppServerLaunch,
    codexRemoteTuiLaunch,
    codexAppServerConfigArgs,
} from '../codex-app-server-lifecycle';

describe('Codex App Server lifecycle launch contracts', () => {
    it('authenticates the loopback App Server with a capability-token file', () => {
        const launch = codexAppServerLaunch({
            codexExecutable: 'codex',
            address: 'ws://127.0.0.1:47891',
            tokenFile: 'C:/private/codex-app.token',
        });

        expect(launch).toEqual({
            command: 'codex',
            args: [
                'app-server',
                '--listen',
                'ws://127.0.0.1:47891',
                '--ws-auth',
                'capability-token',
                '--ws-token-file',
                'C:/private/codex-app.token',
            ],
        });
        expect(JSON.stringify(launch)).not.toContain('plain-secret');
    });

    it('connects the visible Codex TUI through the authenticated remote address', () => {
        expect(codexRemoteTuiLaunch('codex --model gpt-5', 'ws://127.0.0.1:47891')).toBe(
            'codex --model gpt-5 --remote ws://127.0.0.1:47891 --remote-auth-token-env GENIE_CODEX_APP_TOKEN',
        );
    });

    /**
     * A STALE ADDRESS IS WORSE THAN NO ADDRESS.
     *
     * This used to return the command untouched whenever it already carried a
     * `--remote`, which is right about not double-binding and wrong about which
     * address survives. An agent's saved `agent_command` keeps the port from the
     * run it was created in, and Genie's App Server takes a NEW port every time
     * it starts — so every relaunch after a restart pointed codex at a socket
     * nobody was listening on:
     *
     *     Error: failed to connect to remote app server at `ws://127.0.0.1:51340/`:
     *     No connection could be made because the target machine actively refused it.
     *
     * The agent does not degrade, it does not start. Owner-reported, with every
     * codex slave down.
     */
    it('REPLACES a stale address rather than keeping it', () => {
        expect(codexRemoteTuiLaunch('codex --remote ws://127.0.0.1:1', 'ws://127.0.0.1:2')).toBe(
            'codex --remote ws://127.0.0.1:2 --remote-auth-token-env GENIE_CODEX_APP_TOKEN',
        );
    });

    it('still does not add a SECOND binding', () => {
        // The original intent, which was never in doubt. One `--remote`, and one
        // token flag — codex rejects a repeated option.
        const out = codexRemoteTuiLaunch(
            'codex --remote ws://127.0.0.1:1 --remote-auth-token-env GENIE_CODEX_APP_TOKEN',
            'ws://127.0.0.1:2',
        );
        expect(out.match(/--remote /g)).toHaveLength(1);
        expect(out.match(/--remote-auth-token-env/g)).toHaveLength(1);
        expect(out).toContain('ws://127.0.0.1:2');
    });

    it('replaces the address written with `=` too', () => {
        const out = codexRemoteTuiLaunch('codex --remote=ws://127.0.0.1:1', 'ws://127.0.0.1:2');
        expect(out).toContain('ws://127.0.0.1:2');
        expect(out).not.toContain('127.0.0.1:1');
    });

    it('keeps the prompt after `--`, where the flags must not go', () => {
        // The subtlety this function exists for: `--` ends option parsing, so a
        // binding appended after the prompt reads as a subcommand and the TUI
        // exits. Refreshing an address must not undo that.
        const out = codexRemoteTuiLaunch(
            'codex --remote ws://127.0.0.1:1 -- "do the thing"',
            'ws://127.0.0.1:2',
        );
        expect(out).toContain('ws://127.0.0.1:2');
        expect(out.trimEnd().endsWith('-- "do the thing"')).toBe(true);
        expect(out.indexOf('--remote')).toBeLessThan(out.indexOf('--'.padEnd(3) + '"'));
    });

    it('CONTROL: a command with no binding still gets one', () => {
        // Without this, "replaces the stale one" would pass against a function
        // that had stopped binding anything at all.
        expect(codexRemoteTuiLaunch('codex --model gpt-5', 'ws://127.0.0.1:9')).toContain(
            '--remote ws://127.0.0.1:9',
        );
    });

    it('carries managed Codex config overrides into the App Server process', () => {
        expect(codexAppServerConfigArgs(
            `codex --model gpt-5 -c "mcp_servers.genie.url='http://local/token'" -c 'features.foo=true'`,
        )).toEqual([
            '-c',
            "mcp_servers.genie.url='http://local/token'",
            '-c',
            'features.foo=true',
        ]);
    });
});

/**
 * THE REMOTE BINDING HAS TO REACH CODEX'S OPTION PARSER (genie#700).
 *
 * MEASURED against codex-cli 0.151.0 on the owner's workstation: Genie launched
 *
 *   codex --yolo -c "…" -- "<the agent's instructions>" --remote ws://127.0.0.1:62811 …
 *
 * and codex answered `error: unrecognized subcommand '--remote'`, then exited to a
 * shell prompt. The agent never started at all.
 *
 * `--remote` is not missing from that codex — `codex --help` lists it. It is an
 * OPTION, and `--` ENDS option parsing: everything after it is positional, so the
 * flags Genie appends land where codex can only read them as a subcommand name.
 *
 * The old test passed because it used a command with no prompt (`codex --model
 * gpt-5`), which is the one shape production never sends.
 */
describe('the remote flags go where codex can parse them', () => {
    const ADDR = 'ws://127.0.0.1:62811';

    it('inserts the binding BEFORE the `--` that ends codex option parsing', () => {
        const launched = codexRemoteTuiLaunch(`codex --yolo -c "a=1" -- "do the work"`, ADDR);

        expect(launched).toBe(
            `codex --yolo -c "a=1" --remote ${ADDR} --remote-auth-token-env GENIE_CODEX_APP_TOKEN -- "do the work"`,
        );
        // The prompt stays LAST and intact — it is the agent's instructions.
        expect(launched.endsWith(`-- "do the work"`)).toBe(true);
    });

    it('is not fooled by a `--` inside a quoted config value', () => {
        const launched = codexRemoteTuiLaunch(
            `codex -c "notice='ship -- now'" -- "prompt"`,
            ADDR,
        );

        expect(launched).toContain(`"notice='ship -- now'"`);
        expect(launched.indexOf('--remote')).toBeGreaterThan(launched.indexOf('notice='));
        expect(launched.endsWith(`-- "prompt"`)).toBe(true);
    });

    it('still appends when there is no prompt separator at all', () => {
        // The shape the original test covered, kept: a command with no `--` has
        // nothing to insert before, and appending is correct there.
        expect(codexRemoteTuiLaunch('codex --model gpt-5', ADDR)).toBe(
            `codex --model gpt-5 --remote ${ADDR} --remote-auth-token-env GENIE_CODEX_APP_TOKEN`,
        );
    });
});
