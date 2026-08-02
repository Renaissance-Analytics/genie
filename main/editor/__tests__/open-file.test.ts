import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planOpenFile } from '../open-file';

const HOME = path.resolve('/home/glenn');
const WS = path.resolve('/projects/app');
/** A SECOND registered workspace — where a cross-workspace file really lives. */
const OTHER = path.resolve('/projects/other');
const REGISTERED = [
    { id: 'ws1', path: WS },
    { id: 'ws2', path: OTHER },
];

/** Normalise a plan's paths to the host separator for comparison. */
const abs = (p: string) => path.resolve(p);

describe('planOpenFile', () => {
    it('a workspace-relative path roots at the workspace (relative tab)', () => {
        const r = planOpenFile('ws1', WS, HOME, 'src/index.ts', REGISTERED);
        expect('plan' in r).toBe(true);
        if ('plan' in r) {
            expect(r.plan.abs).toBe(abs(path.join(WS, 'src/index.ts')));
            expect(r.plan.workspaceId).toBe('ws1');
            expect(r.plan.root).toBe(WS);
            expect(r.plan.relPath).toBe('src/index.ts');
        }
    });

    it('keeps the FULL relative path when it has directories (never the basename)', () => {
        // genie#…: `.ai/plans/x.md` opened as `<root>/x.md` — the subdirectory
        // was dropped, so the editor read a path that does not exist.
        const r = planOpenFile('ws1', WS, HOME, '.ai/plans/civic-commons.md', REGISTERED);
        if ('plan' in r) {
            expect(r.plan.relPath).toBe('.ai/plans/civic-commons.md');
            expect(r.plan.abs).toBe(abs(path.join(WS, '.ai/plans/civic-commons.md')));
            expect(r.plan.root).toBe(WS);
        } else throw new Error('expected a plan');
    });

    it('an absolute path UNDER the workspace root roots at the workspace', () => {
        const r = planOpenFile('ws1', WS, HOME, path.join(WS, 'a/b.ts'), REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('ws1');
            expect(r.plan.root).toBe(WS);
            expect(r.plan.relPath).toBe('a/b.ts');
        } else throw new Error('expected a plan');
    });

    it('a file inside ANOTHER registered workspace opens in THAT workspace', () => {
        // The reported bug: an agent in ws1 surfaced a file that really lives in
        // ws2. Rooting at the file's DIRECTORY while the panel stays attached to
        // ws1 resolves the tab against ws1's root → `<ws1>/<basename>` (ENOENT).
        const file = path.join(OTHER, '.ai/plans/civic-commons.md');
        const r = planOpenFile('ws1', WS, HOME, file, REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('ws2');
            expect(r.plan.root).toBe(OTHER);
            expect(r.plan.relPath).toBe('.ai/plans/civic-commons.md');
            expect(r.plan.abs).toBe(abs(file));
        } else throw new Error('expected a plan');
    });

    it('prefers the DEEPEST workspace when they nest', () => {
        const nested = path.join(OTHER, 'repos/site');
        const file = path.join(nested, 'src/app.ts');
        const r = planOpenFile('ws1', WS, HOME, file, [
            ...REGISTERED,
            { id: 'ws3', path: nested },
        ]);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('ws3');
            expect(r.plan.root).toBe(nested);
            expect(r.plan.relPath).toBe('src/app.ts');
        } else throw new Error('expected a plan');
    });

    it('an absolute path outside EVERY workspace opens as a System panel', () => {
        // No workspace owns it → the panel must NOT stay attached to the caller's
        // workspace (an attached panel resolves tabs against the WORKSPACE root).
        const outside = abs('/elsewhere/notes/todo.md');
        const r = planOpenFile('ws1', WS, HOME, outside, REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('__system__');
            expect(r.plan.root).toBe(path.dirname(outside));
            expect(r.plan.relPath).toBe('todo.md');
            expect(r.plan.abs).toBe(outside);
        } else throw new Error('expected a plan');
    });

    it('the System workspace roots at the file directory (basename tab)', () => {
        const sys = abs('/var/log/system.log');
        const r = planOpenFile('__system__', null, HOME, sys, REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('__system__');
            expect(r.plan.root).toBe(path.dirname(sys));
            expect(r.plan.relPath).toBe('system.log');
            expect(r.plan.abs).toBe(sys);
        } else throw new Error('expected a plan');
    });

    it('a System relative path resolves against the home dir', () => {
        const r = planOpenFile('__system__', null, HOME, 'notes.txt', REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('__system__');
            expect(r.plan.abs).toBe(abs(path.join(HOME, 'notes.txt')));
            expect(r.plan.root).toBe(HOME);
            expect(r.plan.relPath).toBe('notes.txt');
        } else throw new Error('expected a plan');
    });

    it('a System caller stays in the System workspace even inside a workspace tree', () => {
        // System = the whole-machine browser; a System agent's file opens in ITS
        // workspace (rooted at the file's dir, read unconfined), not elsewhere.
        const inside = path.join(WS, 'src/index.ts');
        const r = planOpenFile('__system__', null, HOME, inside, REGISTERED);
        if ('plan' in r) {
            expect(r.plan.workspaceId).toBe('__system__');
            expect(r.plan.root).toBe(path.dirname(abs(inside)));
            expect(r.plan.relPath).toBe('index.ts');
        } else throw new Error('expected a plan');
    });

    it('an empty path errors', () => {
        expect(planOpenFile('ws1', WS, HOME, '   ', REGISTERED)).toEqual({
            error: 'No file path given.',
        });
    });
});
