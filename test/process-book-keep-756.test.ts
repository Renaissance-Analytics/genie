import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * KEEPING A PROCESS WITHOUT STARTING IT (Tynn #756, PR6). A fresh clone's `.processes/` files become kept processes that are
 * STOPPED (a scheduled task PAUSED): `create` starts what it makes, and starting is the person's, after trust. `keep` is the
 * same record, validated the same way (its folder inside the workspace, its schedule one Genie can evaluate), never run.
 */

let dir = '';
let opened = 0;
let supervisor: ProcessSupervisor;
const pty: PtyPort = { open: () => ({ id: `t-${++opened}`, pid: 5000 + opened, shell: 'test', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} } as unknown as PtyPort;
const open = () => ProcessBook.open(dir, { supervisor, envFor: () => ({}), asleep: (id) => id === 'sleeping' });
const input = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws', workspacePath: dir, name: 'queue-worker', command: 'php artisan queue:work', folder: 'repos/app', restart: 'always' as const, ...over });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-keep-756-'));
    await mkdir(join(dir, 'repos', 'app'), { recursive: true });
    opened = 0;
    supervisor = new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} });
});
afterEach(async () => {
    for (const p of supervisor.list()) supervisor.stop(p.id);
    await rm(dir, { recursive: true, force: true });
});

describe('book.keep', () => {
    it('keeps a process STOPPED: listed, never run, not wanted, and the same after the book is reopened', async () => {
        const book = await open();
        const status = await book.keep(input());
        expect(status).toMatchObject({ name: 'queue-worker', state: 'stopped' });
        expect(opened).toBe(0);
        expect(book.kept().map((p) => [p.name, p.wanted, p.restart])).toEqual([['queue-worker', false, 'always']]);
        expect(book.kept()[0]!.cwd).toBe(join(dir, 'repos', 'app'));
        const again = await open();
        expect(again.kept().map((p) => [p.name, p.wanted])).toEqual([['queue-worker', false]]);
        expect(opened).toBe(0);
    });

    it('keeps a scheduled task PAUSED, and starts nothing', async () => {
        const book = await open();
        await book.keep(input({ name: 'nightly', restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' } }));
        expect(book.scheduledTasks().map((p) => [p.name, p.wanted, p.schedule?.cron])).toEqual([['nightly', false, '0 3 * * *']]);
        expect(opened).toBe(0);
    });

    it('refuses a folder outside the workspace, and a cron nobody can read, and keeps nothing', async () => {
        const book = await open();
        await expect(book.keep(input({ folder: '../outside' }))).rejects.toThrow(/inside the workspace/);
        await expect(book.keep(input({ name: 'x', restart: 'never', schedule: { cron: 'whenever', kind: 'command' } }))).rejects.toThrow(/whenever/);
        expect(book.kept()).toEqual([]);
    });

    it('refuses to keep one in a hibernated workspace', async () => {
        const book = await open();
        await expect(book.keep(input({ workspaceId: 'sleeping' }))).rejects.toThrow(/hibernated/);
        expect(book.kept()).toEqual([]);
    });

    it('CONTROL: create, beside it, still starts what it makes and keeps it wanted', async () => {
        const book = await open();
        await book.create(input());
        expect(opened).toBe(1);
        expect(book.kept().map((p) => [p.name, p.wanted])).toEqual([['queue-worker', true]]);
    });
});
