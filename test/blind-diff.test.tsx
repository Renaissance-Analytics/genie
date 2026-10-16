import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';
import { gitShowHead } from '../src/main/git-ports.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * `Show diff` ON A CHANGE NO AGENT REPORTED (the board's blind banner: "No agent reported this change" + Show diff).
 * Nobody reported a before, but git keeps one: the file as of the last commit. The diff is that against the open
 * text, captioned as such — never presented as "the agent's change". A file with no committed version says so
 * instead of drawing an all-added diff. The banner's terminal door is NOT drawn: it would name an author for a change
 * nobody reported.
 */
const run = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-blind-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('gitShowHead against a real git', () => {
    it('the last committed text; an untracked file and a plain folder have none', async () => {
        const work = join(dir, 'work');
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        await mkdir(join(work, 'src'));
        await writeFile(join(work, 'src', 'a.ts'), 'one\n');
        await run('git', ['-C', work, 'add', '.']);
        await run('git', ['-C', work, 'commit', '--quiet', '-m', 'a'], { env });
        await writeFile(join(work, 'src', 'a.ts'), 'two\n');
        await writeFile(join(work, 'src', 'b.ts'), 'new\n');
        expect(await gitShowHead(work, 'src/a.ts')).toBe('one\n');
        expect(await gitShowHead(work, 'src/b.ts')).toBeNull();
        await writeFile(join(dir, 'plain.ts'), 'x\n');
        expect(await gitShowHead(dir, 'plain.ts')).toBeNull();
    }, 30_000);
});

describe('the files host', () => {
    it('answers through its port for a confined path; outside the workspace it answers nothing', async () => {
        const seen: string[] = [];
        const host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: dir } : null), agentsOf: () => [], eventsOf: () => [], gitShowHead: async (_root, rel) => { seen.push(rel); return 'before\n'; } });
        expect(await host.lastCommitted('tynn', 'src/a.ts')).toBe('before\n');
        expect(await host.lastCommitted('tynn', '../outside.ts')).toBeNull();
        expect(seen).toEqual(['src/a.ts']);
    });
});

describe('the banner', () => {
    const props = (over: Partial<FilesPanelProps>): FilesPanelProps => ({
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
        state: { files: [], activity: [], unreported: ['src/a.ts'], changed: null },
        tabs: ['src/a.ts'],
        open: { ok: true, path: 'src/a.ts', text: 'two\n', sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
        ...over,
    });

    it('offers Show diff, draws the last commit against the open text with its caption, and no terminal door', () => {
        const offer = renderToStaticMarkup(<FilesPanel {...props({ onShowDiff: () => {} })} />);
        expect(offer).toMatch(/data-unreported-banner="src\/a\.ts"[\s\S]*data-action="show-diff"/);
        expect(offer).not.toMatch(/terminal/i);
        const shown = renderToStaticMarkup(<FilesPanel {...props({ onShowDiff: () => {}, blindDiff: { path: 'src/a.ts', before: 'one\n' } })} />);
        expect(shown).toMatch(/data-blind-diff="src\/a\.ts"[\s\S]*Against the last commit/);
    });

    it('a file with no committed version says so; without the host read there is no button (positive control above)', () => {
        const none = renderToStaticMarkup(<FilesPanel {...props({ onShowDiff: () => {}, blindDiff: { path: 'src/a.ts', before: null } })} />);
        expect(none).toContain('Not in the last commit, so there is nothing to compare it with.');
        expect(none).not.toContain('data-blind-diff=');
        expect(renderToStaticMarkup(<FilesPanel {...props({})} />)).not.toContain('data-action="show-diff"');
    });
});
