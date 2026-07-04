import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePluginBinary, readPluginBinary } from '../../files/ipc';
import { BUNDLED_PLUGIN_SOURCES } from '../official';

/**
 * Phase-1 EXIT CRITERION — an agent generates a REAL .pptx/.xlsx into a
 * workspace, gated by the capability bridge, with no fs escape.
 *
 * This runs the ACTUAL bundled plugin `tools.cjs` (from the embedded sources)
 * with a fake bridge whose `fs.writeBytes` is the REAL guarded, extension-limited
 * `writePluginBinary` — the exact path the worker-host bridge takes. So it
 * exercises the real generation (dark-slide / holy-sheet `Agent.toBytes` →
 * bytes) AND the real guard end to end, without needing an Electron
 * `utilityProcess`. A .pptx/.xlsx must land inside the workspace with a valid
 * OOXML (PK zip) header; an out-of-scope write must fail closed.
 */

const HERE = __dirname;
const PK_MAGIC = '504b0304'; // OOXML packages are ZIP archives.

let scratch: string; // lives UNDER the repo so tools.cjs resolves node_modules

beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(HERE, '.gen-'));
});
afterAll(() => {
    try {
        fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

/** Materialise a bundled plugin's tools.cjs under the repo tree and load it. */
function loadTools(id: string): Record<string, (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const src = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === id);
    if (!src) throw new Error(`missing bundled source ${id}`);
    const dir = fs.mkdtempSync(path.join(scratch, 'p-'));
    const file = path.join(dir, 'tools.cjs');
    fs.writeFileSync(file, src.tools);
    const req = createRequire(file);
    return req(file);
}

/** A fake capability bridge whose fs ops ARE the real guarded helpers. */
function bridgeFor(wsRoot: string, exts: string[]) {
    return {
        fs: {
            writeBytes: (rel: string, bytes: Uint8Array) =>
                writePluginBinary(wsRoot, rel, Buffer.from(bytes), exts),
            readBytes: async (rel: string) => {
                const r = await readPluginBinary(wsRoot, rel, exts);
                return { base64: r.base64 };
            },
        },
    };
}

describe('Presentation.createDeck (dark-slide → .pptx)', () => {
    const EXTS = ['.pptx', '.odp'];

    it('writes a real .pptx into the workspace, guard-scoped', async () => {
        const ws = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const tools = loadTools('ai.genie.presentation');
        const res = await tools.createDeck(
            {
                title: 'Q3 Review',
                slides: [
                    { title: 'Intro', bullets: ['Revenue up', 'Costs down'] },
                    { title: 'Numbers', body: 'Solid quarter.' },
                ],
            },
            bridgeFor(ws, EXTS),
        );
        expect(res.isError).toBeFalsy();
        const out = path.join(ws, 'q3-review.pptx');
        expect(fs.existsSync(out)).toBe(true);
        expect(fs.readFileSync(out).subarray(0, 4).toString('hex')).toBe(PK_MAGIC);
        expect(res.content[0].text).toMatch(/2 slide/);
    });

    it('honours an explicit output path within scope', async () => {
        const ws = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const tools = loadTools('ai.genie.presentation');
        const res = await tools.createDeck(
            { slides: [{ title: 'One' }], path: 'decks/one.pptx' },
            bridgeFor(ws, EXTS),
        );
        expect(res.isError).toBeFalsy();
        expect(fs.existsSync(path.join(ws, 'decks', 'one.pptx'))).toBe(true);
    });

    it('FAILS CLOSED on an out-of-scope output path', async () => {
        const ws = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const tools = loadTools('ai.genie.presentation');
        await expect(
            tools.createDeck({ slides: [{ title: 'x' }], path: '../escape.pptx' }, bridgeFor(ws, EXTS)),
        ).rejects.toThrow(/escapes workspace/i);
        expect(fs.existsSync(path.join(path.dirname(ws), 'escape.pptx'))).toBe(false);
    });
});

describe('Spreadsheet.createWorkbook (holy-sheet → .xlsx)', () => {
    const EXTS = ['.xlsx', '.csv', '.ods'];

    it('writes a real .xlsx from structured sheets, guard-scoped', async () => {
        const ws = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const tools = loadTools('ai.genie.spreadsheet');
        const res = await tools.createWorkbook(
            {
                title: 'Sales',
                sheets: [
                    {
                        name: 'Q3',
                        columns: [{ header: 'Region' }, { header: 'Revenue' }],
                        rows: [
                            ['West', 120],
                            ['East', 98],
                        ],
                    },
                ],
            },
            bridgeFor(ws, EXTS),
        );
        expect(res.isError).toBeFalsy();
        const out = path.join(ws, 'sales.xlsx');
        expect(fs.existsSync(out)).toBe(true);
        expect(fs.readFileSync(out).subarray(0, 4).toString('hex')).toBe(PK_MAGIC);
    });

    it('builds a workbook from a flat rows array', async () => {
        const ws = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const tools = loadTools('ai.genie.spreadsheet');
        const res = await tools.createWorkbook(
            { rows: [['a', 'b'], [1, 2], [3, 4]], headers: ['A', 'B'] },
            bridgeFor(ws, EXTS),
        );
        expect(res.isError).toBeFalsy();
        expect(fs.existsSync(path.join(ws, 'workbook.xlsx'))).toBe(true);
    });
});
