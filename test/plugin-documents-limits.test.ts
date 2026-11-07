import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { workbookFromBytes } from '../src/renderer/plugin-documents.js';

/*
 * A WORKBOOK OVER A READ LIMIT OPENS AS A SENTENCE, NEVER AS A BLANK SHEET OR A STACK TRACE (Tynn #399, holy-sheet
 * 2.13.0). The Files editor reads a workbook through workbookFromBytes (src/renderer/plugin-documents.ts), and shows what
 * it throws as its error line (PluginEditorBody). A workbook holy-sheet refuses (a read limit, a DOCTYPE in a part, the
 * archive's size limits) says which limit and the number, in words a person reads.
 *
 * Each fixture is a small xlsx built here part by part. CONTROL: the same builder's ordinary workbook opens with its value.
 * The over-wide column is read in a child process with a time limit and a 256 MB heap, so a read that never ends, or
 * that fills memory, fails this row instead of the suite.
 */
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function sheetXml(inner: { cols?: string; rows?: string; before?: string; comment?: string }): string {
    const rows = inner.rows ?? '<row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${inner.before ?? ''}<worksheet xmlns="${MAIN}">${inner.comment ? `<!--${inner.comment}-->` : ''}${inner.cols ?? ''}<sheetData>${rows}</sheetData></worksheet>`;
}

function xlsx(sheet: string): Promise<Uint8Array> {
    const parts: Record<string, string> = {
        '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
        '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN}" xmlns:r="${OFFICE_REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        'xl/worksheets/sheet1.xml': sheet,
    };
    const zip = new ZipFile();
    for (const [name, text] of Object.entries(parts)) zip.addBuffer(Buffer.from(text, 'utf8'), name);
    const chunks: Buffer[] = [];
    return new Promise((done, fail) => {
        zip.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => done(new Uint8Array(Buffer.concat(chunks)))).on('error', fail);
        zip.end();
    });
}

/** What the editor would show: the opened sheet's first value, or the error's words. */
function opened(bytes: Uint8Array): { value: string | null } | { error: string } {
    try {
        const book = workbookFromBytes('book.xlsx', bytes);
        const cells = book.workbook.sheets[0]?.cells ?? {};
        return { value: String(Object.values(cells)[0]?.value ?? '') || null };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** A sentence for a person: no library tag, no exception name, no stack frame, no internal key. */
function expectASentence(text: string): void {
    expect(text).toMatch(/^[A-Z]/);
    expect(text).toMatch(/\.$/);
    expect(text).not.toMatch(/\[holy-sheet\]|Refused|Exception|Error:|\n\s+at |archive_limit|read_limit|max(Rows|Columns|Cells|SharedStrings)/);
}

describe('a workbook holy-sheet refuses opens as a sentence (the Files editor read path)', () => {
    it('CONTROL: the fixture builder\'s ordinary workbook opens, with its value', async () => {
        expect(opened(await xlsx(sheetXml({})))).toEqual({ value: 'hello' });
    });

    it('a sheet past the row limit: which limit and the count, not a sheet', async () => {
        const r = opened(await xlsx(sheetXml({ rows: '<row r="2000000"><c r="A2000000" t="inlineStr"><is><t>far</t></is></c></row>' })));
        expect(r).toHaveProperty('error');
        const text = (r as { error: string }).error;
        expectASentence(text);
        expect(text).toMatch(/2,000,000 rows/);
        expect(text).toMatch(/1,048,576/);
    });

    it('a part carrying a DOCTYPE is refused in words, never opened as an empty sheet', async () => {
        const r = opened(await xlsx(sheetXml({ before: '<!DOCTYPE worksheet [<!ENTITY a "x">]>' })));
        expect(r).toHaveProperty('error');
        const text = (r as { error: string }).error;
        expectASentence(text);
        expect(text).toMatch(/DOCTYPE/);
    });

    it('a part over the 64 MiB part limit: which part, its size and the limit', async () => {
        // Random hex packs at about 2:1, so the archive stays under its own 64 MiB and the part limit is the one met.
        const r = opened(await xlsx(sheetXml({ comment: randomBytes(34 * 1024 * 1024).toString('hex') })));
        expect(r).toHaveProperty('error');
        const text = (r as { error: string }).error;
        expectASentence(text);
        expect(text).toMatch(/xl\/worksheets\/sheet1\.xml/);
        expect(text).toMatch(/68\.0 MiB/);
        expect(text).toMatch(/64 MiB/);
    }, 60_000);
});

describe('a column range of two billion is refused at once, in bounded time and memory', () => {
    let dir: string;
    let script: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'sheet-limits-'));
        script = join(dir, 'read.mjs');
        // The editor's own read path, in a process of its own: the result, or its words, and how long it took.
        writeFileSync(script, [
            `import { readFileSync } from 'node:fs';`,
            `const { workbookFromBytes } = await import(${JSON.stringify(pathToFileURL(resolve('src/renderer/plugin-documents.ts')).href)});`,
            `const bytes = new Uint8Array(readFileSync(process.argv[2]));`,
            `const began = performance.now();`,
            `let out;`,
            `try { const b = workbookFromBytes('book.xlsx', bytes); out = { ok: true, cells: Object.keys(b.workbook.sheets[0]?.cells ?? {}).length }; }`,
            `catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }`,
            `out.ms = Math.round(performance.now() - began);`,
            `console.log('RESULT ' + JSON.stringify(out));`,
        ].join('\n'));
    });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    async function readInChild(bytes: Uint8Array): Promise<{ code: number | null; timedOut: boolean; result: { ok: boolean; error?: string; cells?: number; ms: number } | null; tail: string }> {
        const file = join(dir, `book-${Date.now()}.xlsx`);
        writeFileSync(file, bytes);
        const child = spawn(process.execPath, ['--max-old-space-size=256', '--import', import.meta.resolve('tsx'), script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
        const code = await new Promise<number | null>((done) => child.once('exit', done));
        clearTimeout(timer);
        const line = /^RESULT (.*)$/m.exec(out)?.[1];
        return { code, timedOut, result: line ? JSON.parse(line) : null, tail: out.slice(-600) };
    }

    it('CONTROL: the child reads an ordinary workbook through the same path', async () => {
        const r = await readInChild(await xlsx(sheetXml({})));
        expect(r.result, r.tail).toMatchObject({ ok: true, cells: 1 });
    }, 60_000);

    it('<col min="1" max="2000000000">: refused in words, within 5 s and a 256 MB heap', async () => {
        const r = await readInChild(await xlsx(sheetXml({ cols: '<cols><col min="1" max="2000000000" width="12" customWidth="1"/></cols>' })));
        expect(r.timedOut, `the read did not end within 30 s\n${r.tail}`).toBe(false);
        expect(r.result, `the child ended with no result (code ${r.code}: out of memory?)\n${r.tail}`).not.toBeNull();
        expect(r.result!.ok, JSON.stringify(r.result)).toBe(false);
        expectASentence(r.result!.error!);
        expect(r.result!.error).toMatch(/2,000,000,000 columns/);
        expect(r.result!.error).toMatch(/16,384/);
        expect(r.result!.ms).toBeLessThan(5_000);
    }, 60_000);
});
