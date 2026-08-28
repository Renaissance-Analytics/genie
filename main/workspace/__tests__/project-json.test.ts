import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    PROJECT_JSON_SCHEMA,
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
        expect(read?.$schema).toBe(PROJECT_JSON_SCHEMA);
        // project.json ships in the monorepo — it must never carry a
        // token/secret. Guard against a tynnToken field creeping back.
        expect(read).not.toHaveProperty('tynnToken');
        expect(blankProjectJson('Foo', 'foo')).not.toHaveProperty('tynnToken');
    });

    it('backs up an unstamped project before the first schema migration', () => {
        const dir = makeTmpDir('pj-schema-migration');
        const original = JSON.stringify({ name: 'Legacy', futureFlag: 'keep-me' }, null, 2) + '\n';
        fs.writeFileSync(path.join(dir, 'project.json'), original);

        writeProjectJson(dir, { description: 'migrated' });

        const backups = fs.readdirSync(dir).filter((name) => name.startsWith('project.json.pre-schema-'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(original);
        expect(readProjectJson(dir)).toMatchObject({
            $schema: PROJECT_JSON_SCHEMA,
            name: 'Legacy',
            description: 'migrated',
            futureFlag: 'keep-me',
        });

        writeProjectJson(dir, { description: 'migrated again' });
        expect(fs.readdirSync(dir).filter((name) => name.startsWith('project.json.pre-schema-'))).toHaveLength(1);
    });

    it('migrates the previous shared schema with a backup and preserves unknown fields', () => {
        const dir = makeTmpDir('pj-v011-migration');
        const file = path.join(dir, 'project.json');
        fs.writeFileSync(file, JSON.stringify({
            $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.1.1/schemas/workspace/project.schema.json',
            name: 'Legacy',
            futureFlag: 'keep-me',
        }, null, 2) + '\n');

        writeProjectJson(dir, { description: 'current' });

        expect(readProjectJson(dir)).toMatchObject({
            $schema: PROJECT_JSON_SCHEMA,
            name: 'Legacy',
            description: 'current',
            futureFlag: 'keep-me',
        });
        expect(fs.readdirSync(dir).filter((name) => name.endsWith('.bak'))).toHaveLength(1);
    });

    it('refuses to overwrite a project stamped with an unsupported schema', () => {
        const dir = makeTmpDir('pj-future-schema');
        const file = path.join(dir, 'project.json');
        const original = JSON.stringify({
            $schema: 'https://example.test/shared-schemas/v99/project.schema.json',
            name: 'Future',
        }, null, 2) + '\n';
        fs.writeFileSync(file, original);

        expect(() => writeProjectJson(dir, { description: 'must not write' })).toThrow(
            /unsupported project\.json schema/i,
        );
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
    });

    it('refuses to migrate an existing project that cannot be parsed', () => {
        const dir = makeTmpDir('pj-invalid-migration');
        const file = path.join(dir, 'project.json');
        fs.writeFileSync(file, '{ broken json');

        expect(() => writeProjectJson(dir, { description: 'must not write' })).toThrow(
            /cannot migrate invalid project\.json/i,
        );
        expect(fs.readFileSync(file, 'utf8')).toBe('{ broken json');
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
