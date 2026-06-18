import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    blankProjectJson,
    readProjectJson,
    writeProjectJson,
} from '../project-json';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

describe('project-json', () => {
    it('returns null when project.json does not exist', () => {
        const dir = makeTmpDir('pj-missing');
        expect(readProjectJson(dir)).toBeNull();
    });

    it('writes a blank then reads it back', () => {
        const dir = makeTmpDir('pj-blank');
        writeProjectJson(dir, blankProjectJson('Foo', 'foo'));

        const read = readProjectJson(dir);
        expect(read?.name).toBe('Foo');
        expect(read?.repos).toEqual([]);
        expect(read?.hosting?.mode).toBe('development');
        expect(read?.hosting?.enabled).toBe(false);
        expect(read?.type).toBeNull();
        expect(typeof read?.createdAt).toBe('string');
        // project.json ships in the monorepo — it must never carry a
        // token/secret. Guard against a tynnToken field creeping back.
        expect(read).not.toHaveProperty('tynnToken');
        expect(blankProjectJson('Foo', 'foo')).not.toHaveProperty('tynnToken');
    });

    it('preserves unknown top-level fields across patches', () => {
        const dir = makeTmpDir('pj-unknown');
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                name: 'Foo',
                agiGateway: { customField: 42, nested: { keep: true } },
                futureFlag: 'preserve-me',
            }),
        );

        writeProjectJson(dir, { description: 'patched' });

        const read = readProjectJson(dir) as Record<string, unknown>;
        expect(read.description).toBe('patched');
        expect(read.name).toBe('Foo');
        expect(read.futureFlag).toBe('preserve-me');
        expect((read.agiGateway as Record<string, unknown>).customField).toBe(42);
        expect(
            ((read.agiGateway as Record<string, unknown>).nested as Record<string, unknown>).keep,
        ).toBe(true);
    });

    it('merges nested hosting fields rather than replacing them', () => {
        const dir = makeTmpDir('pj-hosting');
        writeProjectJson(dir, {
            name: 'Foo',
            hosting: { enabled: true, hostname: 'a.example.com', mode: 'staging' },
        });

        writeProjectJson(dir, { hosting: { hostname: 'b.example.com' } });

        const read = readProjectJson(dir);
        expect(read?.hosting?.hostname).toBe('b.example.com');
        // Untouched fields stay put — the writer merges, doesn't replace.
        expect(read?.hosting?.enabled).toBe(true);
        expect(read?.hosting?.mode).toBe('staging');
    });

    it('merges the nested tynn link block and never stores a token', () => {
        const dir = makeTmpDir('pj-tynn');
        writeProjectJson(dir, {
            name: 'Foo',
            tynn: { host: 'https://tynn.ai', owner: 'wishborn', project: 'foo', projectId: '01ABC' },
        });

        // A later patch updates one field; the rest of the link survives.
        writeProjectJson(dir, { tynn: { projectId: '01XYZ' } });

        const read = readProjectJson(dir);
        expect(read?.tynn?.projectId).toBe('01XYZ');
        expect(read?.tynn?.host).toBe('https://tynn.ai');
        expect(read?.tynn?.owner).toBe('wishborn');
        expect(read?.tynn?.project).toBe('foo');
        // Mapping only — the tynn block must never carry a secret.
        expect(read?.tynn).not.toHaveProperty('token');
    });

    it('atomic-writes via a temp file (no lingering .tmp)', () => {
        const dir = makeTmpDir('pj-atomic');
        writeProjectJson(dir, blankProjectJson('Foo', 'foo'));
        const files = fs.readdirSync(dir);
        expect(files).toContain('project.json');
        expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
});
