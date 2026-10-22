import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@particle-academy/prism-mcp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { doctorDataTools } from '../src/main/doctor-data.js';
import { doctorTools, type DoctorOsa } from '../src/main/doctor-mcp.js';
import { DoctorRun } from '../src/main/doctor-run.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { genieMcpServer } from '../src/main/mcp-server.js';
import type { Registration } from '../src/main/mcp-tools.js';
import { PluginHost } from '../src/main/plugin-host.js';

/**
 * EVERY TOOL GENIE SERVES HAS A TITLE — measured as Claude receives it. The first doctor trial of the doctor data tools
 * (2026-10-13): genie's session connected to its `genie` server and had NO tools. Claude's debug log: "tools/list
 * failed (Invalid result for tools/list: … tools[0].title … expected string, received null)" — one tool without a title
 * and Claude rejects the WHOLE list. prism-mcp-server serializes a ToolDefinition's absent title as `null` (the spec
 * allows it absent, never null), and the six new doctor tools had none. So every server Genie runs is listed here over
 * real HTTP and every tool must carry a string title.
 *
 * AGAIN, 2026-10-22 (beta.35 → every Claude agent had NO Genie tools). Claude Code 2.1.301's MCP log:
 * `Failed to fetch tools: Invalid result for tools/list: path ["tools",17,"title"] … expected string, received null`
 * (and 18, 19). The official plugins' tools (#1064: `ai.genie.spreadsheet.createWorkbook`,
 * `ai.genie.presentation.createDeck`, `ai.genie.artboard.post`) were built without a title — and this test had
 * listed "normal Genie" with NO plugins at all, so it could not see them. Normal Genie is now built the way main.ts
 * builds it: the real plugin host with the official plugins, and every optional part (agents, tabs, pages).
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

/** tools/list over the MODERN protocol (2026-07-28) through the real prism-mcp-server, on the in-memory transport. */
async function listedModern(registrations: Registration[]): Promise<unknown> {
    const transport = new InMemoryTransport();
    const server = genieMcpServer({ registrations, transport });
    await server.start();
    stops.push(() => server.stop());
    return transport.request({ method: 'tools/list', params: { _meta: META } });
}

/**
 * The MCP spec's `Tool` (schema.ts) as a checker: `name: string`; `title?: string`; `description?: string`;
 * `inputSchema: { type: "object", … }`; `outputSchema?: object`; `annotations?: { title?: string, …hints?: boolean }`;
 * `icons?: array`; `_meta?: object`. An OPTIONAL field is absent or of its type — `null` is never one of them, which is
 * exactly the shape Claude's validator enforces ("expected string, received null"). Returns the violations by path.
 */
function specViolations(result: unknown): string[] {
    const out: string[] = [];
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    const optional = (path: string, v: unknown, ok: (x: unknown) => boolean, type: string) => {
        if (v === undefined) return;
        if (!ok(v)) out.push(`${path}: expected ${type}, received ${v === null ? 'null' : typeof v}`);
    };
    const str = (x: unknown) => typeof x === 'string';
    const bool = (x: unknown) => typeof x === 'boolean';
    if (!isObj(result) || !Array.isArray(result.tools)) return ['result.tools: expected array'];
    optional('nextCursor', result.nextCursor, str, 'string');
    result.tools.forEach((t, i) => {
        const p = `tools[${i}]`;
        if (!isObj(t)) { out.push(`${p}: expected object`); return; }
        if (typeof t.name !== 'string' || t.name === '') out.push(`${p}.name: expected non-empty string`);
        optional(`${p}.title`, t.title, str, 'string');
        optional(`${p}.description`, t.description, str, 'string');
        if (!isObj(t.inputSchema) || t.inputSchema.type !== 'object') out.push(`${p}.inputSchema: expected { type: "object" }`);
        optional(`${p}.outputSchema`, t.outputSchema, isObj, 'object');
        optional(`${p}.icons`, t.icons, Array.isArray, 'array');
        optional(`${p}._meta`, t._meta, isObj, 'object');
        optional(`${p}.annotations`, t.annotations, isObj, 'object');
        if (isObj(t.annotations)) {
            optional(`${p}.annotations.title`, t.annotations.title, str, 'string');
            for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) optional(`${p}.annotations.${h}`, t.annotations[h], bool, 'boolean');
        }
    });
    return out;
}

const never = (() => { throw new Error('not exercised'); }) as never;
const osa: DoctorOsa = { tell: async () => ({ ok: true }), ask: async () => ({ ok: false, reason: 'x' }), transcript: () => [], status: () => ({}) };
const facts = { version: '2', platform: 'win32', installDir: 'I', genieHome: 'H', userData: 'U' };

/** Normal Genie's registrations the way main.ts builds them: every part, and the REAL plugin host with the official plugins. */
async function normalGenie(): Promise<Registration[]> {
    const plugins = await PluginHost.open({ dir: join(home, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
    return allGenieTools(genieToolDeps({
        inbox: never, attention: never, knowledge: never, settings: never, approve: never, roster: () => [], resolveCaller: () => null,
        userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
        agents: { defaultAgentOf: () => null, register: never },
        workspaceTabs: { write: () => {}, sites: () => [] },
        pages: { open: () => [] },
        plugins: { tools: () => plugins.tools(), guard: (id) => plugins.guard(id), run: never },
    }));
}

describe('every tool Genie serves', () => {
    const servers: Array<[string, () => Registration[] | Promise<Registration[]>]> = [
        ['normal Genie', normalGenie],
        ['the doctor channel', () => doctorTools(osa, facts)],
        ['doctor genie’s data tools', () => doctorDataTools({ genieHome: home })],
        ['doctor genie’s run tools', () => new DoctorRun({ genieHome: home, besideHome: home, genieRunning: () => ({ running: false }), prepareOsaHome: async () => {} }).tools()],
    ];
    for (const [server, build] of servers) {
        it(`${server}: a string title on every tool in tools/list, as Claude receives it (counted; the offenders named)`, async () => {
            const tools = await listedOverHttp(await build());
            expect(tools.length).toBeGreaterThan(0);
            expect(tools.filter((t) => typeof t.title !== 'string' || t.title === '').map((t) => t.name)).toEqual([]);
        });

        it(`${server}: the whole tools/list result over the MODERN protocol passes the MCP spec's Tool shape — no null title`, async () => {
            const result = await listedModern(await build());
            expect(specViolations(result)).toEqual([]);
        });

        it(`${server}: every registration carries a non-empty title — the next new tool cannot ship without one`, async () => {
            const regs = await build();
            expect(regs.length).toBeGreaterThan(0);
            expect(regs.filter((r) => typeof r.definition.title !== 'string' || r.definition.title.trim() === '').map((r) => r.definition.name)).toEqual([]);
        });
    }

    it('normal Genie includes the official plugin tools (the positive control: the list above really carries them)', async () => {
        const names = (await normalGenie()).map((r) => r.definition.name);
        expect(names).toEqual(expect.arrayContaining(['ai.genie.spreadsheet.createWorkbook', 'ai.genie.presentation.createDeck', 'ai.genie.artboard.post', 'createAgent', 'workspaceTabs', 'pages']));
        const listed = (await listedModern(await normalGenie())) as { tools: Array<{ name: string }> };
        expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ai.genie.spreadsheet.createWorkbook', 'ai.genie.presentation.createDeck', 'ai.genie.artboard.post']));
    });

    it('a plugin tool is titled "<plugin name>: <tool name in words>", like Genie’s own ("Manage terminals")', async () => {
        const titles = Object.fromEntries((await normalGenie()).filter((r) => r.definition.name.startsWith('ai.genie.')).map((r) => [r.definition.name, r.definition.title]));
        expect(titles).toEqual({
            'ai.genie.spreadsheet.createWorkbook': 'Spreadsheet: Create workbook',
            'ai.genie.presentation.createDeck': 'Presentation: Create deck',
            'ai.genie.artboard.post': 'ArtBoard: Post',
        });
    });

    it('the spec checker can see a null title (its own positive control)', () => {
        expect(specViolations({ tools: [{ name: 'x', title: null, inputSchema: { type: 'object' } }] })).toEqual(['tools[0].title: expected string, received null']);
        expect(specViolations({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] })).toEqual([]);
    });
});
