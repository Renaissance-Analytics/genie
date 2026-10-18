import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workspaceFileOf } from '../src/core/terminal-links.js';

/**
 * A FILE PATH IN A TERMINAL OPENS IN GENIE (Tynn #763; fancy-term 0.8.0's `links`). Compiler errors, test failures and
 * stack traces print `src/app.ts:42:7`; a click opens that file in the workspace's own file panel, AT THE LINE —
 * the same place an agent's `openFileForUser` lands. Only a file INSIDE the workspace opens: a path elsewhere on the
 * machine (or one that only looks like the workspace — `/w/tynn-other`) is not Genie's to show, and opens nothing.
 * URLs keep going to the browser (#957).
 */
describe('which file, in the workspace', () => {
    it('a path inside the workspace: relative to it, forward slashes, with the line', () => {
        expect(workspaceFileOf('/w/tynn', { path: 'src/app.ts', absolutePath: '/w/tynn/src/app.ts', line: 42 })).toEqual({ path: 'src/app.ts', line: 42 });
        expect(workspaceFileOf('/w/tynn', { path: './x.mjs', absolutePath: '/w/tynn/x.mjs' })).toEqual({ path: 'x.mjs', line: null });
    });

    it('Windows: either slash, and a drive path compares without case', () => {
        expect(workspaceFileOf('C:\\Work\\Tynn', { path: 'C:\\work\\tynn\\src\\a.ts', absolutePath: 'C:/work/tynn/src/a.ts', line: 12 })).toEqual({ path: 'src/a.ts', line: 12 });
    });

    it('outside the workspace opens nothing (COUNTED: none of four)', () => {
        const outside = [
            { path: '/etc/passwd', absolutePath: '/etc/passwd' },
            { path: '../tynn-other/x.ts', absolutePath: '/w/tynn-other/x.ts' },
            { path: '.', absolutePath: '/w/tynn' },
            { path: 'C:\\Windows\\a.dll', absolutePath: 'C:/Windows/a.dll' },
        ];
        expect(outside.map((f) => workspaceFileOf('/w/tynn', f)).filter((r) => r !== null)).toEqual([]);
    });

    it('no absolute path handed over: resolved against the workspace (CONTROL: still confined)', () => {
        expect(workspaceFileOf('/w/tynn', { path: 'src/b.ts', line: 3 })).toEqual({ path: 'src/b.ts', line: 3 });
        expect(workspaceFileOf('/w/tynn', { path: '../../etc/passwd' })).toBeNull();
    });
});

describe('the wiring', () => {
    it('the pane hands URLs to the browser and files to Genie, relative paths resolved against the workspace', () => {
        const pane = readFileSync('src/renderer/components/TerminalPane.tsx', 'utf8');
        expect(pane).toMatch(/links=\{\{/);
        expect(pane).toMatch(/url: \(url\) => \{ if \(\/\^https\?:\/i\.test\(url\)\) window\.open\(url, '_blank', 'noopener'\); \},/);
        expect(pane).toMatch(/file: \(file\) => onOpenFile\?\.\(file\),/);
        expect(pane).toMatch(/root,/);
    });

    it('the workspace opens it in its file panel at the line — openFileRoute, as openFileForUser does', () => {
        const ws = readFileSync('src/renderer/components/Workspace.tsx', 'utf8');
        expect(ws).toMatch(/const target = workspaceFileOf\(workspace\.path, file\);/);
        expect(ws).toMatch(/if \(target\) onOpenFile\?\.\(target\.path, target\.line\);/);
        const shell = readFileSync('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toMatch(/onOpenFile=\{\(path, line\) => onNavigate\(openFileRoute\(parsed\.workspaceId, path, line\)\)\}/);
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        expect(pkg.dependencies['@particle-academy/fancy-term']).toBe('^0.8.0');
    });
});
