import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import { claudeChannelEntry, setChannelBridgeNode } from '../agent-config';

/**
 * THE CHANNEL BRIDGE MUST NOT RUN ON THE BINARY AN UPDATE REPLACES (genie#346).
 *
 * Every Claude agent's `genie-agentinbox-channel` was written as
 * `Genie.exe` + `ELECTRON_RUN_AS_NODE=1`. On Windows the NSIS updater stops every
 * process whose path is inside the install directory before it swaps the files
 * — electron-builder's `allowOnlyOneInstallerInstance.nsh`:
 *
 *     Get-CimInstance Win32_Process | ? { $_.Path.StartsWith('$INSTDIR') } | Stop-Process
 *
 * so every update killed every agent's channel. Measured after beta.324 on the
 * owner's machine: nine Claude agent sessions alive from before the upgrade, and
 * the only channel bridge left was the one a person had just reconnected by hand.
 * A stdio MCP server that has been killed cannot supervise itself back; Claude
 * Code does not restart it.
 *
 * The pty host and the MCP shuttle already run on Genie's STANDALONE Node,
 * materialised under user data precisely so an update cannot touch them. The
 * bridge now runs there too.
 */
describe('claudeChannelEntry — which binary the bridge runs on', () => {
    afterEach(() => setChannelBridgeNode(null));

    const WS = path.join('C:', 'work', 'acme');
    const URL = 'http://127.0.0.1:51717/mcp/abc';
    const NODE = 'C:\\Users\\u\\AppData\\Roaming\\genie\\runtime\\20.20.2-win32-x64\\node.exe';

    it('runs on Genie\'s standalone Node, outside the install directory, as plain Node', () => {
        setChannelBridgeNode(() => NODE);
        const entry = claudeChannelEntry(WS, URL) as {
            command: string;
            args: string[];
            env: Record<string, string>;
        };

        expect(entry.command).toBe(NODE);
        expect(entry.args).toEqual([path.join(WS, '.agents', '_genie', 'agentinbox-claude-channel.cjs')]);
        // Plain Node needs no Electron switch; carrying one would be a claim about
        // a binary this is not.
        expect(entry.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(entry.env.GENIE_MCP_URL).toBe(URL);
        expect(entry.env.GENIE_TERMINAL_ID).toBe('${GENIE_TERMINAL_ID:-}');
    });

    it('falls back to Genie\'s own binary only when there is no standalone runtime at all', () => {
        // A channel that dies on the next update beats no channel. This is the
        // build-without-a-runtime case, not a choice.
        setChannelBridgeNode(() => null);
        expect((claudeChannelEntry(WS, URL) as { command: string }).command).toBe(process.execPath);
    });

    it('falls back the same way when resolving the runtime throws', () => {
        setChannelBridgeNode(() => {
            throw new Error('materialise failed');
        });
        expect((claudeChannelEntry(WS, URL) as { command: string }).command).toBe(process.execPath);
    });
});
