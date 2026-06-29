import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planOpenFile } from '../open-file';

const HOME = path.resolve('/home/glenn');
const WS = path.resolve('/projects/app');

/** Normalise a plan's paths to the host separator for comparison. */
const abs = (p: string) => path.resolve(p);

describe('planOpenFile', () => {
    it('a workspace-relative path roots at the workspace (relative tab)', () => {
        const r = planOpenFile('ws1', WS, HOME, 'src/index.ts');
        expect('plan' in r).toBe(true);
        if ('plan' in r) {
            expect(r.plan.abs).toBe(abs(path.join(WS, 'src/index.ts')));
            expect(r.plan.root).toBe(WS);
            expect(r.plan.relPath).toBe('src/index.ts');
        }
    });

    it('an absolute path UNDER the workspace root roots at the workspace', () => {
        const r = planOpenFile('ws1', WS, HOME, path.join(WS, 'a/b.ts'));
        if ('plan' in r) {
            expect(r.plan.root).toBe(WS);
            expect(r.plan.relPath).toBe('a/b.ts');
        } else throw new Error('expected a plan');
    });

    it('an absolute path OUTSIDE the workspace roots at the file directory', () => {
        const outside = abs('/elsewhere/notes/todo.md');
        const r = planOpenFile('ws1', WS, HOME, outside);
        if ('plan' in r) {
            expect(r.plan.root).toBe(path.dirname(outside));
            expect(r.plan.relPath).toBe('todo.md');
            expect(r.plan.abs).toBe(outside);
        } else throw new Error('expected a plan');
    });

    it('the System workspace roots at the file directory (basename tab)', () => {
        const sys = abs('/var/log/system.log');
        const r = planOpenFile('__system__', null, HOME, sys);
        if ('plan' in r) {
            expect(r.plan.root).toBe(path.dirname(sys));
            expect(r.plan.relPath).toBe('system.log');
            expect(r.plan.abs).toBe(sys);
        } else throw new Error('expected a plan');
    });

    it('a System relative path resolves against the home dir', () => {
        const r = planOpenFile('__system__', null, HOME, 'notes.txt');
        if ('plan' in r) {
            expect(r.plan.abs).toBe(abs(path.join(HOME, 'notes.txt')));
            expect(r.plan.root).toBe(HOME);
            expect(r.plan.relPath).toBe('notes.txt');
        } else throw new Error('expected a plan');
    });

    it('an empty path errors', () => {
        expect(planOpenFile('ws1', WS, HOME, '   ')).toEqual({ error: 'No file path given.' });
    });
});
