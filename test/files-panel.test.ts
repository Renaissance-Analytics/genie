import { describe, expect, it } from 'vitest';
import { FILE_SIZE_CAP, activityFrom, attributionFrom, buildTree, changedGroups, confine, openRefusal, unreportedChanges } from '../src/core/files-panel.js';

/**
 * THE WORKSPACE FILE PANEL'S MODEL (§4.3). One panel per workspace. Attribution comes from the agents'
 * own edit events — never guessed: a file that changed on disk with no report is neutral with a `?`.
 * A file shows ONE dot plus a COUNT, never one dot per agent. `rawInput` is untrusted: a `file_path`
 * outside the workspace root produces no marker and no error row. The Changes section is absent, not
 * empty, when nothing changed. A file Genie will not open says so in words, with its size.
 */

const root = '/w/tynn';
const edit = (agent: string, file_path: string, status: 'in_progress' | 'completed' | 'failed', rawInput: unknown = { file_path }) =>
    ({ agentId: `agent_${agent}`, agentName: agent, toolKind: 'edit' as const, status, rawInput });
const read = (agent: string, file_path: string, status: 'in_progress' | 'completed') =>
    ({ agentId: `agent_${agent}`, agentName: agent, toolKind: 'read' as const, status, rawInput: { file_path } });

describe('confine', () => {
    it('keeps a path inside the root, relative and forward-slashed; anything outside is null, never an error', () => {
        expect(confine(root, '/w/tynn/src/a.ts')).toBe('src/a.ts');
        expect(confine(root, 'src\\b.ts')).toBe('src/b.ts');
        expect(confine(root, '/w/tynn/src/../src/c.ts')).toBe('src/c.ts');
        expect(confine(root, '/w/tynn/../other/d.ts')).toBeNull();
        expect(confine(root, '/etc/passwd')).toBeNull();
        expect(confine(root, '../../e.ts')).toBeNull();
        expect(confine(root, '/w/tynn2/f.ts')).toBeNull();
    });
});

describe('buildTree', () => {
    it('folders first, then files, each level alphabetical; ids are relative paths; ext from the name', () => {
        const tree = buildTree([
            { path: 'src/main.ts', kind: 'file' }, { path: 'README.md', kind: 'file' }, { path: 'src', kind: 'dir' },
            { path: 'src/components', kind: 'dir' }, { path: 'src/components/App.tsx', kind: 'file' }, { path: 'package.json', kind: 'file' },
        ]);
        expect(tree.map((n) => n.id)).toEqual(['src', 'package.json', 'README.md']);
        expect(tree[0]).toMatchObject({ id: 'src', label: 'src', type: 'folder' });
        expect(tree[0]!.children!.map((n) => n.id)).toEqual(['src/components', 'src/main.ts']);
        expect(tree[0]!.children![0]!.children![0]).toMatchObject({ id: 'src/components/App.tsx', label: 'App.tsx', ext: 'tsx', type: 'file' });
        expect(buildTree([])).toEqual([]);
    });
});

describe('attributionFrom', () => {
    it('one entry per file with ONE dot plus a COUNT; in-flight edits are violet (writing now), completed ones green (changed this session)', () => {
        const events = [
            ...Array.from({ length: 20 }, (_, i) => edit(`a${i}`, '/w/tynn/db.ts', 'completed')),
            edit('kora', '/w/tynn/main/ipc.ts', 'in_progress'),
            edit('kora', '/w/tynn/main/ipc.ts', 'completed'),
            edit('wren', '/w/tynn/main/ipc.ts', 'in_progress'),
        ];
        const a = attributionFrom(events, root);
        expect(a.get('db.ts')).toMatchObject({ count: 20, inFlight: false });
        expect(a.get('db.ts')!.agents.map((x) => x.name)).toHaveLength(20);
        // kora's call completed (latest status per agent and file wins); wren's is still in flight.
        expect(a.get('main/ipc.ts')).toMatchObject({ count: 2, inFlight: true, agents: [{ id: 'agent_kora', name: 'kora' }, { id: 'agent_wren', name: 'wren' }] });
        expect(attributionFrom([edit('kora', '/w/tynn/x.ts', 'in_progress'), edit('kora', '/w/tynn/x.ts', 'completed')], root).get('x.ts')).toMatchObject({ count: 1, inFlight: false });
    });

    it('rawInput is untrusted: a path outside the root, a null rawInput, a failed edit and a read produce NO marker and no error', () => {
        const a = attributionFrom([
            edit('kora', '/etc/passwd', 'completed'),
            edit('kora', '../../x.ts', 'completed'),
            edit('kora', '', 'completed', null),
            edit('kora', '/w/tynn/never.ts', 'failed'),
            read('zane', '/w/tynn/model.ts', 'in_progress'),
        ], root);
        expect([...a.keys()]).toEqual([]);
    });
});

describe('activityFrom + unreportedChanges + changedGroups', () => {
    it('the footer names who is touching what; a disk change nobody reported is `?`, never attributed', () => {
        const events = [edit('kora', '/w/tynn/main/ipc.ts', 'in_progress'), read('zane', '/w/tynn/model.ts', 'in_progress'), edit('wren', '/w/tynn/a.ts', 'completed')];
        expect(activityFrom(events, root)).toEqual([
            { agent: 'kora', verb: 'writing', path: 'main/ipc.ts' },
            { agent: 'zane', verb: 'reading', path: 'model.ts' },
        ]);
        const a = attributionFrom(events, root);
        expect(unreportedChanges(a, ['a.ts', 'mystery.ts', '/w/tynn/main/ipc.ts', '/etc/outside'], root)).toEqual(['mystery.ts']);
    });

    it('Changed groups files by who changed them, you included; nothing changed → null (absent, not empty)', () => {
        const a = attributionFrom([edit('kora', '/w/tynn/main/ipc.ts', 'completed'), edit('kora', '/w/tynn/b.ts', 'completed'), edit('zane', '/w/tynn/b.ts', 'completed')], root);
        expect(changedGroups(a, { mine: ['notes.md'], unreported: ['mystery.ts'] })).toEqual([
            { who: 'you', files: ['notes.md'] },
            { who: 'kora', files: ['b.ts', 'main/ipc.ts'] },
            { who: 'zane', files: ['b.ts'] },
            { who: '?', files: ['mystery.ts'] },
        ]);
        expect(changedGroups(new Map(), { mine: [], unreported: [] })).toBeNull();
    });
});

describe('openRefusal', () => {
    it('under the cap opens; at or over it refuses in words with the size, never a blank editor', () => {
        expect(openRefusal(FILE_SIZE_CAP - 1)).toBeNull();
        expect(openRefusal(180 * 1024 * 1024)).toBe('this file is 180 MB; Genie will not open it');
        expect(openRefusal(FILE_SIZE_CAP)).toMatch(/Genie will not open it$/);
    });
});
