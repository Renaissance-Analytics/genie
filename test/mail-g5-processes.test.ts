import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bcryptHash } from '../src/main/mail-bcrypt.js';
import { MailService, type MailServicePorts } from '../src/main/mail-service.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * GENIE MAIL G5: RUNNING BACKGROUND PROCESSES GET THE CREDENTIALS BEFORE MAILPIT READS THE BOOK (the owner's ruling via the
 * coordinator, 2026-11-08: "a running queue worker with the old env sends with no credentials and gets 530"). A process
 * reads its env as it starts, so every RUNNING process of a workspace getting credentials is restarted, as its sites are,
 * and only then is Mailpit wired. A process that cannot restart holds the wiring back, saying why; the next sync tries
 * again. The real Mailpit proves a running process sends after wiring: test/mailpit-measure/mail-g5-env.accept.ts.
 */
type Started = { id: string; workspaceId: string; name: string; env?: Record<string, string> };

function fakeSupervisor() {
    const running = new Map<string, Started & { state: ProcessStatus['state'] }>();
    const starts: Started[] = [];
    const status = (s: Started & { state: ProcessStatus['state'] }): ProcessStatus => ({ id: s.id, workspaceId: s.workspaceId, name: s.name, state: s.state, pid: 1, exitCode: null, restarts: 0, since: 0 });
    return {
        starts,
        running,
        supervisor: {
            start: (spec: Started) => { const s = { ...spec, state: 'running' as const }; running.set(spec.id, s); starts.push(spec); return status(s); },
            stop: (id: string) => { const s = running.get(id); if (s) running.set(id, { ...s, state: 'stopped' }); },
            forget: (id: string) => { running.delete(id); },
            list: (workspaceId?: string) => [...running.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId).map(status),
        },
    };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g5-proc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the process book restarts a workspace\'s running processes with the env as it is now', () => {
    it('only the running, unscheduled processes of the named workspaces; each started again with the new env', async () => {
        const sup = fakeSupervisor();
        let env: Record<string, string> = { MAIL_PORT: '1025' };
        const asleep = new Set<string>();
        const book = await ProcessBook.open(dir, { supervisor: sup.supervisor as never, envFor: () => env, asleep: (ws) => asleep.has(ws) });
        const worker = await book.create({ workspaceId: 'ws-a', workspacePath: join(dir, 'a'), name: 'queue', command: 'php artisan queue:work', restart: 'always' });
        const stopped = await book.create({ workspaceId: 'ws-a', workspacePath: join(dir, 'a'), name: 'idle', command: 'sleep 1', restart: 'never' });
        await book.stop(stopped.id);
        const other = await book.create({ workspaceId: 'ws-b', workspacePath: join(dir, 'b'), name: 'other', command: 'run', restart: 'always' });
        sup.starts.length = 0;
        env = { MAIL_PORT: '1025', MAIL_USERNAME: 'app@ws-a.mail.gen', MAIL_PASSWORD: 'pw' };
        const r = await book.restartRunning(['ws-a']);
        expect(r).toEqual({ restarted: [worker.id], failed: [] });
        expect(sup.starts).toEqual([expect.objectContaining({ id: worker.id, env: expect.objectContaining({ MAIL_USERNAME: 'app@ws-a.mail.gen', MAIL_PASSWORD: 'pw' }) })]);
        // Control: another workspace's running process is left alone, and the stopped one stays stopped.
        expect(sup.running.get(other.id)?.state).toBe('running');
        expect(sup.running.get(stopped.id)?.state).toBe('stopped');
    });

    it('a process that cannot restart is named with the reason', async () => {
        const sup = fakeSupervisor();
        const asleep = new Set<string>();
        const book = await ProcessBook.open(dir, { supervisor: sup.supervisor as never, envFor: () => ({}), asleep: (ws) => asleep.has(ws) });
        const worker = await book.create({ workspaceId: 'ws-a', workspacePath: join(dir, 'a'), name: 'queue', command: 'run', restart: 'always' });
        asleep.add('ws-a');
        const r = await book.restartRunning(['ws-a']);
        expect(r.restarted).toEqual([]);
        expect(r.failed).toEqual([{ id: worker.id, name: 'queue', reason: expect.stringMatching(/hibernated/) }]);
    });
});

describe('Mailpit is wired only after the running processes have the credentials', () => {
    let events: string[];
    let wired: boolean;
    let processes: NonNullable<MailServicePorts['restartProcesses']>;
    let said: string[];
    const ports = (): MailServicePorts => ({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        secrets: { get: async () => null, set: async () => true },
        attachedWorkspaces: () => ['ws-a', 'ws-b'],
        wired: () => wired,
        wire: async () => { wired = true; events.push('wire'); },
        restart: async () => { events.push('restart'); },
        envChanged: (ids) => { events.push(`env:${[...ids].sort().join(',')}`); },
        restartProcesses: (ids) => processes(ids),
        say: (line) => { said.push(line); },
    });
    beforeEach(() => {
        events = [];
        wired = false;
        said = [];
        processes = async (ids) => { events.push(`processes:${[...ids].sort().join(',')}`); return { ok: true }; };
    });

    it('credentials, the env (sites), the running processes, and only then Mailpit reads the book', async () => {
        const service = await MailService.open(ports());
        await service.sync();
        expect(events).toEqual(['env:ws-a,ws-b', 'processes:ws-a,ws-b', 'wire']);
        expect(service.waiting()).toBeNull();
    });

    it('a process that cannot restart holds the wiring back and says why; the next sync tries again, then wires', async () => {
        processes = async (ids) => { events.push(`processes:${[...ids].sort().join(',')}`); return { ok: false, reason: 'queue (ws-a): its workspace is hibernated' }; };
        const service = await MailService.open(ports());
        await service.sync();
        expect(events).toEqual(['env:ws-a,ws-b', 'processes:ws-a,ws-b']);
        expect(wired).toBe(false);
        expect(service.waiting()).toMatch(/queue \(ws-a\): its workspace is hibernated/);
        expect(said.join('\n')).toMatch(/not reading the inbox book yet[\s\S]*queue \(ws-a\): its workspace is hibernated/);
        // Fixed: the next sync restarts the processes still waiting, then wires.
        events = [];
        processes = async (ids) => { events.push(`processes:${[...ids].sort().join(',')}`); return { ok: true }; };
        await service.sync();
        expect(events).toEqual(['processes:ws-a,ws-b', 'wire']);
        expect(service.waiting()).toBeNull();
    });
});
