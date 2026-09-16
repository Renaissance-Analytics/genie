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

    it('does not add a second remote binding', () => {
        const command = 'codex --remote ws://127.0.0.1:1';
        expect(codexRemoteTuiLaunch(command, 'ws://127.0.0.1:2')).toBe(command);
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
