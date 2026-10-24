import { parseCommandLine } from '@particle-academy/fancy-term-host';
import { describe, expect, it } from 'vitest';
import { devServerFor, readEnvelopeSites, siteEntryFor } from '../src/core/envelope-sites.js';

const entry = { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'argv', genName: 'argv.gen' };
const read = (argv: string[], key: 'command' | 'serve' = 'command') => readEnvelopeSites({ sites: { argv: { ...entry, [key]: argv } } })[0]!;
const write = (command: string) => siteEntryFor({}, { name: 'argv', repoDir: '.', serve: { mode: 'proxy' }, devServer: { command } });

describe('envelope argv uses the actual process parser grammar', () => {
    const unsupported = [
        ['literal quote', 'before"after'],
        ['backslash then quote and apparent flags', 'before\\" --injected after'],
        ['repeated quotes', 'one" two" three'],
        ['NUL', 'before\0after'],
    ] as const;

    for (const key of ['command', 'serve'] as const) {
        it.each(unsupported)(`${key}: refuses %s before producing a runnable site`, (_name, token) => {
            const site = read(['node', token], key);
            expect(site.ok, 'unrepresentable argv must remain visible as an unservable site').toBe(false);
            if (site.ok) throw new Error('expected refusal');
            expect(site.reason).toMatch(/command.*(quote|NUL)/);
        });
    }

    it.each(unsupported)('direct formatter refuses %s instead of inventing an escape syntax', (_name, token) => {
        expect(() => devServerFor(['node', token], {})).toThrow(/command.*(quote|NUL)/);
    });

    it.each([
        ['Windows path ending in a backslash', ['node', 'C:\\Program Files\\server\\']],
        ['UNC path', ['node', '\\\\server\\shared folder\\entry.js']],
        ['empty and literal metacharacter arguments', ['node', '', 'a b', 'a\\ b', '$HOME', '$(unused)', '`unused`', 'x&y|z%']],
    ] as const)('%s survives the real parser and manifest write/read', (_name, argv) => {
        const generated = devServerFor(argv, {}).command;
        const parsed = parseCommandLine(generated);
        expect([parsed.command, ...parsed.args]).toEqual(argv);
        const saved = write(generated);
        expect(saved.ok).toBe(true);
        if (!saved.ok) throw new Error(saved.reason);
        expect(saved.entry.command).toEqual(argv);
        const restored = readEnvelopeSites({ sites: { argv: saved.entry } })[0]!;
        expect(restored.ok).toBe(true);
        if (!restored.ok) throw new Error(restored.reason);
        expect(restored.devServer!.command).toBe(generated);
    });

    it.each([
        ['literal double quote inside a single-quoted word', 'node \'has"quote\''],
        ['NUL', 'node before\0after'],
        ['unfinished double quote', 'node "unfinished'],
        ['unfinished single quote', 'node \'unfinished'],
    ])('manifest writer refuses %s rather than storing a different command', (_name, command) => {
        const result = write(command!);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected refusal');
        expect(result.reason).toMatch(/command.*(quote|NUL)/);
    });
});
