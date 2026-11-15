import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunIdentity } from '../scripts/agent-reads-acquire.mjs';

const io = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn(), entries: vi.fn(), stat: vi.fn(), hostname: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: io.exec, spawn: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: io.read, readdirSync: io.entries, lstatSync: io.stat }));
vi.mock('node:os', () => ({ hostname: io.hostname }));
import { readMeasurementIdentity } from '../scripts/agent-reads-process.mjs';

const key = (path: string) => resolve(path).replaceAll('\\', '/');
let files: Map<string, string>;
let links: Set<string>;
beforeEach(() => {
    for (const mock of [io.exec, io.read, io.entries, io.stat, io.hostname]) mock.mockReset();
    io.exec.mockImplementation(() => { throw new Error('Git metadata unavailable'); });
    io.hostname.mockReturnValue('fixture-vm');
    const fixtures: readonly (readonly [string, string])[] = [
        ['package.json', '{"type":"module"}'], ['package-lock.json', '{"lockfileVersion":3}'],
        ['dist/main/entry.js', 'entry fixture'], ['dist/main/host.js', 'host fixture'],
        ['dist/main/preload.cjs', 'preload fixture'], ['dist/renderer/index.html', '<p>renderer fixture</p>'],
    ];
    files = new Map(fixtures.map(([path, content]) => [key(path), content]));
    links = new Set();
    io.read.mockImplementation((path: string) => {
        const value = files.get(key(path));
        if (value === undefined) throw new Error(`missing fixture artifact: ${path}`);
        return Buffer.from(value);
    });
    io.stat.mockImplementation((path: string) => ({
        isSymbolicLink: () => links.has(key(path)), isFile: () => files.has(key(path)),
        isDirectory: () => [...files.keys()].some((file) => file.startsWith(`${key(path)}/`)),
        size: Buffer.byteLength(files.get(key(path)) ?? ''),
    }));
    io.entries.mockImplementation((path: string) => {
        const prefix = `${key(path)}/`;
        const names = new Set([...files.keys(), ...links].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]!));
        return [...names].reverse().map((name) => ({ name,
            isSymbolicLink: () => links.has(`${prefix}${name}`),
            isFile: () => files.has(`${prefix}${name}`),
            isDirectory: () => [...files.keys()].some((file) => file.startsWith(`${prefix}${name}/`)),
        }));
    });
});

describe('identity on Azure source archives without .git (Tynn #564)', () => {
    it('fingerprints the actual full app artifacts and notices changed host bytes', () => {
        let first: RunIdentity | undefined;
        expect(() => { first = readMeasurementIdentity('fixture-run'); }).not.toThrow();
        expect(first?.build).toMatch(/^artifact-sha256:[a-f0-9]{64}$/);
        expect(first).toMatchObject({ vmId: 'fixture-vm', platform: process.platform, runId: 'fixture-run' });
        files.set(key('dist/main/host.js'), 'different host bytes');
        expect(readMeasurementIdentity('fixture-run').build).not.toBe(first?.build);
    });

    it('refuses an incomplete build instead of fingerprinting a tree without its preload', () => {
        files.delete(key('dist/main/preload.cjs'));
        expect(() => readMeasurementIdentity('fixture-run')).toThrow(/artifact|preload/i);
    });

    it('refuses linked artifacts rather than reading outside the built tree', () => {
        links.add(key('dist/main/planted.cjs'));
        expect(() => readMeasurementIdentity('fixture-run')).toThrow(/symlink|linked artifact/i);
    });
});
