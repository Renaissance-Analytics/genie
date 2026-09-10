import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Hermetic: the writer reads workspace sync settings and the plugin registry,
   and neither decides anything this file is about. Stubbing them keeps the test
   off the real database instead of creating one as a side effect. */
vi.mock('../../db', () => ({ getAllSettings: () => ({}) }));
vi.mock('../../plugins/registry', () => ({ pluginAgentSkills: () => [] }));

import { GENIE_ENDPOINT_SERVERS, genieEndpointServers } from '../genie-servers';
import { writeWorkspaceAgentMcp } from '../agent-config';
import { codexServerNames, jsonServerMap } from '../../agents/agent-mcp';
import { reconnectStrategy } from '../../agents/mcp-reconnect';

const URL = 'http://127.0.0.1:51717/mcp/abc123';

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'genie-endpoint-servers-'));
}

function jsonServers(file: string): string[] {
    if (!fs.existsSync(file)) return [];
    return Object.keys(jsonServerMap(JSON.parse(fs.readFileSync(file, 'utf8')))).sort();
}

function codexServers(file: string): string[] {
    if (!fs.existsSync(file)) return [];
    return codexServerNames(fs.readFileSync(file, 'utf8')).sort();
}

/**
 * genie#613 — the post-upgrade notice named ONE of the two servers Genie
 * configures against its own endpoint, so `genie-agentinbox-channel` stayed
 * dead until a human noticed.
 *
 * The fix is a single declaration, `GENIE_ENDPOINT_SERVERS`, that the WRITER
 * writes from and the NOTICE reads from. `agent-config.ts` is coupled to it at
 * compile time (its entry-builder tables are keyed by `GenieEndpointServer<…>`,
 * so a name added to the declaration stops that file compiling until it is
 * actually written) — but a compile error only proves the table has an entry,
 * not that the entry reaches disk. This is the other half: what
 * `writeWorkspaceAgentMcp` ACTUALLY leaves in an agent's config, read back off
 * the filesystem, is the same list the notice names.
 */
describe('the declared Genie-endpoint servers are the ones actually written', () => {
    let ws: string;

    beforeEach(() => {
        ws = workspace();
    });

    it('writes exactly the declared set into each harness config', () => {
        writeWorkspaceAgentMcp(ws, true, URL);

        const claude = jsonServers(path.join(ws, '.mcp.json'));
        // POSITIVE CONTROL. "The written set matches the declaration" passes
        // trivially if nothing was written at all and the declaration were
        // empty, and the bug was a list that was too SHORT — so assert first
        // that this actually wrote something, with the real endpoint in it.
        expect(claude.length).toBeGreaterThan(1);
        expect(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).toContain(URL);

        expect(claude).toEqual([...GENIE_ENDPOINT_SERVERS.claude].sort());
        expect(jsonServers(path.join(ws, '.cursor', 'mcp.json'))).toEqual(
            [...GENIE_ENDPOINT_SERVERS.cursor].sort(),
        );
        expect(codexServers(path.join(ws, '.codex', 'config.toml'))).toEqual(
            [...GENIE_ENDPOINT_SERVERS.codex].sort(),
        );
    });

    it('is the SAME list the post-upgrade notice names — per harness', () => {
        // The regression this whole file exists for: the writer put two servers
        // in `.mcp.json` and the reconnect named one of them.
        writeWorkspaceAgentMcp(ws, true, URL);

        expect([...reconnectStrategy('claude').servers].sort()).toEqual(
            jsonServers(path.join(ws, '.mcp.json')),
        );
        expect([...reconnectStrategy('cursor').servers].sort()).toEqual(
            jsonServers(path.join(ws, '.cursor', 'mcp.json')),
        );
        expect([...reconnectStrategy('codex').servers].sort()).toEqual(
            codexServers(path.join(ws, '.codex', 'config.toml')),
        );
    });

    it('removes every declared server on disable, leaving a foreign one alone', () => {
        writeWorkspaceAgentMcp(ws, true, URL);
        const file = path.join(ws, '.mcp.json');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            mcpServers: Record<string, unknown>;
        };
        parsed.mcpServers.someone_elses = { command: 'x' };
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2));

        writeWorkspaceAgentMcp(ws, false, URL);

        // Genie removes what Genie wrote, all of it, and nothing else. A server
        // left behind pointing at a dead endpoint is what makes a harness report
        // "failed to connect" for the rest of the session.
        expect(jsonServers(file)).toEqual(['someone_elses']);
    });

    it('falls back to the `.mcp.json` set for a TUI it cannot place', () => {
        // A registered-but-never-started agent, or a terminal from a newer build
        // whose `meta.agent` never got written. Erring LONG is the deliberate
        // direction: naming a server this harness turns out not to have costs
        // one refused reconnect, and naming one too few is genie#613.
        expect(genieEndpointServers(null)).toEqual(GENIE_ENDPOINT_SERVERS.claude);
        expect(genieEndpointServers('kilo')).toEqual(GENIE_ENDPOINT_SERVERS.claude);
        expect(genieEndpointServers(undefined)).toEqual(GENIE_ENDPOINT_SERVERS.claude);
    });

    it('leaves `tynn` out — a Genie upgrade does not replace it', () => {
        // Genie writes that entry too (`writeWorkspaceTynnMcp`), but it points at
        // Tynn production on Laravel Cloud, which sleeps after ~30 minutes
        // without HTTP traffic. Its disconnects have nothing to do with an
        // upgrade, and a notice that claimed otherwise would send agents chasing
        // two causes as one.
        for (const source of ['claude', 'cursor', 'codex'] as const) {
            expect(GENIE_ENDPOINT_SERVERS[source]).not.toContain('tynn');
        }
    });
});
