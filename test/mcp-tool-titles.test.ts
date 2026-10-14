import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorDataTools } from '../src/main/doctor-data.js';
import { doctorTools, type DoctorOsa } from '../src/main/doctor-mcp.js';
import { DoctorRun } from '../src/main/doctor-run.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { genieMcpServer } from '../src/main/mcp-server.js';
import type { Registration } from '../src/main/mcp-tools.js';

/**
 * EVERY TOOL GENIE SERVES HAS A TITLE — measured as Claude receives it. The first doctor trial of the doctor data tools
 * (2026-10-13): genie's session connected to its `genie` server and had NO tools. Claude's debug log: "tools/list
 * failed (Invalid result for tools/list: … tools[0].title … expected string, received null)" — one tool without a title
 * and Claude rejects the WHOLE list. prism-mcp-server serializes a ToolDefinition's absent title as `null` (the spec
 * allows it absent, never null), and the six new doctor tools had none. So every server Genie runs is listed here over
 * real HTTP and every tool must carry a string title.
 */
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
let home: string;
const stops: Array<() => Promise<unknown>> = [];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie2-titles-')); });
afterEach(async () => { for (const s of stops.splice(0)) await s(); await rm(home, { recursive: true, force: true }); });

async function listedOverHttp(registrations: Registration[]): Promise<Array<Record<string, unknown>>> {
    const server = genieMcpServer({ registrations, port: 0 });
    const { url, token } = await server.start();
    stops.push(() => server.stop());
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }) });
    return ((await res.json()) as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
}

const never = (() => { throw new Error('not exercised'); }) as never;
const osa: DoctorOsa = { tell: async () => ({ ok: true }), ask: async () => ({ ok: false, reason: 'x' }), transcript: () => [], status: () => ({}) };
const facts = { version: '2', platform: 'win32', installDir: 'I', genieHome: 'H', userData: 'U' };

describe('every tool Genie serves', () => {
    const servers: Array<[string, () => Registration[]]> = [
        ['normal Genie', () => allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, feedback: never, approve: never, roster: () => [], resolveCaller: () => null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
            sidecar: { register: never, start: never, running: () => false },
            plugins: { tools: () => [], guard: () => null, run: never },
        }))],
        ['the doctor channel', () => doctorTools(osa, facts)],
        ['doctor genie’s data tools', () => doctorDataTools({ genieHome: home })],
        ['doctor genie’s run tools', () => new DoctorRun({ genieHome: home, besideHome: home, genieRunning: () => ({ running: false }), prepareOsaHome: async () => {} }).tools()],
    ];
    for (const [server, build] of servers) {
        it(`${server}: a string title on every tool in tools/list, as Claude receives it (counted; the offenders named)`, async () => {
            const tools = await listedOverHttp(build());
            expect(tools.length).toBeGreaterThan(0);
            expect(tools.filter((t) => typeof t.title !== 'string' || t.title === '').map((t) => t.name)).toEqual([]);
        });
    }
});
