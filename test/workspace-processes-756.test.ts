import { describe, expect, it } from 'vitest';
import { withElements, type ElementSources } from '../src/core/workspace-elements.js';
import { PROCESS_SCHEMA_URL, processesDeclaration, processTrustItems, type ProcessSource } from '../src/core/workspace-processes.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';
import type { LiveModel } from '../src/core/workspace-save.js';
import { elementSourcesFor, type SourcePorts } from '../src/main/workspace-save-sources.js';
import { restoreProcesses, type ProcessPorts } from '../src/main/workspace-processes-host.js';

/**
 * BACKGROUND PROCESSES AND SCHEDULED TASKS, SAVED AS FILES (Tynn #756, PR6): each is `.processes/<name>.json` (shared-schemas
 * v0.5.0 process.schema.json): what to run, the folder it runs in RELATIVE to the workspace, its restart policy and, for a
 * scheduled task, its cron. Never its id, whether it is running (`wanted`), its last run, or an absolute path. A fresh clone
 * keeps every one STOPPED (a scheduled task PAUSED): starting is the person's, after the workspace's one-time trust.
 * A process's folder is read by the same `cwd` rule the guard applies. Fixtures are invented names.
 */

const WS = 'ws_acme';
const ROOT = 'C:/_Projects/acme';
const worker = (over: Partial<ProcessSource> = {}): ProcessSource => ({ name: 'Queue worker', workspaceId: WS, command: 'php artisan queue:work', cwd: `${ROOT}/repos/app`, restart: 'always', ...over });
const nightly = (over: Partial<ProcessSource> = {}): ProcessSource => worker({ name: 'Nightly dump', command: 'php artisan db:dump', restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' }, ...over });
const nudge = (over: Partial<ProcessSource> = {}): ProcessSource => worker({ name: 'Morning nudge', command: '', cwd: ROOT, restart: 'never', schedule: { cron: '0 8 * * 1-5', kind: 'agent-nudge', prompt: 'Check the queue.', agent: 'lift@acme' }, ...over });

describe('the file a process is saved as', () => {
    it('is .processes/<name>.json with the schema stamp, what it runs, its folder relative to the workspace and its restart policy', () => {
        const { files, excluded } = processesDeclaration([worker()], WS, ROOT);
        expect(excluded).toEqual([]);
        expect(files).toEqual([{ path: '.processes/queue-worker.json', value: { $schema: PROCESS_SCHEMA_URL, command: 'php artisan queue:work', folder: 'repos/app', restart: 'always' } }]);
        expect(PROCESS_SCHEMA_URL).toBe('https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/process.schema.json');
    });

    it('a process that runs in the workspace folder itself has no folder', () => {
        const { files } = processesDeclaration([worker({ cwd: ROOT })], WS, ROOT);
        expect(files[0]!.value).toEqual({ $schema: PROCESS_SCHEMA_URL, command: 'php artisan queue:work', restart: 'always' });
    });

    it('a scheduled task: its cron and kind, and no restart policy (the schedule decides)', () => {
        const { files } = processesDeclaration([nightly()], WS, ROOT);
        expect(files[0]!.value).toEqual({ $schema: PROCESS_SCHEMA_URL, command: 'php artisan db:dump', folder: 'repos/app', schedule: { cron: '0 3 * * *', kind: 'command' } });
    });

    it('an agent nudge: the agent by NAME (not its inbox address), the prompt, and a command that says what it is', () => {
        const { files } = processesDeclaration([nudge()], WS, ROOT);
        expect(files[0]!.value).toEqual({ $schema: PROCESS_SCHEMA_URL, command: 'agent-nudge', schedule: { cron: '0 8 * * 1-5', kind: 'agent-nudge', prompt: 'Check the queue.', agent: 'lift' } });
    });

    it('never carries its id, whether it runs, its last run, or an absolute path: the guard finds nothing', () => {
        const loaded = { ...worker(), id: 'proc_1', wanted: true, changedAt: 5 } as ProcessSource;
        const sched = nightly({ schedule: { cron: '0 3 * * *', kind: 'command', lastRunAt: 99, lastRunStatus: 'ok' } });
        const { files } = processesDeclaration([loaded, sched], WS, ROOT);
        expect(files).toHaveLength(2);
        expect(JSON.stringify(files)).not.toMatch(/proc_1|wanted|changedAt|lastRun|C:\//);
        expect(scanForMachineState(files.map((f) => f.value))).toEqual([]);
    });

    it('one that runs OUTSIDE the workspace is left out and said; another workspace’s processes are not this one’s at all', () => {
        const out = processesDeclaration([worker({ name: 'Elsewhere', cwd: 'D:/other/app' }), worker(), worker({ name: 'Theirs', workspaceId: 'ws_other' })], WS, ROOT);
        expect(out.files.map((f) => f.path)).toEqual(['.processes/queue-worker.json']);
        expect(out.excluded).toEqual([{ field: '.processes/elsewhere.json', reason: expect.stringContaining('outside the workspace') }]);
    });

    it('an agent nudge whose agent is not a Genie agent name, and a process with nothing to run, are left out and said', () => {
        const out = processesDeclaration([nudge({ schedule: { cron: '0 8 * * *', kind: 'agent-nudge', prompt: 'p', agent: 'Lift Bot@acme' } }), worker({ name: 'Empty', command: '  ' })], WS, ROOT);
        expect(out.files).toEqual([]);
        expect(out.excluded.map((e) => e.field)).toEqual(['.processes/morning-nudge.json', '.processes/empty.json']);
    });

    it('CONTROL: no processes is no files', () => {
        expect(processesDeclaration([], WS, ROOT)).toEqual({ files: [], excluded: [] });
    });
});

describe('what a person must trust before a process comes in', () => {
    it('lists what each would run, an agent nudge as what it asks', () => {
        const { files } = processesDeclaration([worker(), nudge()], WS, ROOT);
        expect(processTrustItems(files)).toEqual([
            { file: '.processes/queue-worker.json', commands: ['php artisan queue:work'] },
            { file: '.processes/morning-nudge.json', commands: ['ask lift: Check the queue.'] },
        ]);
    });

    it('CONTROL: nothing saved is nothing to trust', () => {
        expect(processTrustItems([])).toEqual([]);
    });
});

describe('processes in Save to repo', () => {
    const model = (): LiveModel => ({ manifest: { name: 'Acme' }, manifestText: '{"name":"Acme"}\n', files: [{ path: '.flows/a.json', value: { v: 1 } }] });
    const sources = (processes?: ProcessSource[]): ElementSources => ({ services: [], workspace: { overrides: {}, defaultAgent: null, envFile: null, mcpOff: [] }, agents: [], ...(processes ? { processes } : {}) });

    it('are files beside the rest, whose files stay; one left out is told with the rest', () => {
        const out = withElements(model(), sources([worker(), worker({ name: 'Elsewhere', cwd: 'D:/other' })]), WS, ROOT);
        expect(out.model.files.map((f) => f.path)).toEqual(['.flows/a.json', '.processes/queue-worker.json']);
        expect(out.excluded.map((e) => e.field)).toEqual(['.processes/elsewhere.json']);
    });

    it('CONTROL: sources with no processes leave the files as they were', () => {
        expect(withElements(model(), sources(), WS, ROOT).model.files.map((f) => f.path)).toEqual(['.flows/a.json']);
    });

    it('the workspace’s processes are read as name, command, folder, restart and schedule only: no id, intent or history', () => {
        const record = { id: 'proc_1', workspaceId: WS, name: 'Queue worker', command: 'php artisan queue:work', cwd: `${ROOT}/repos/app`, restart: 'always', wanted: true, changedAt: 1, schedule: { cron: '0 3 * * *', kind: 'command', lastRunAt: 5, lastRunStatus: 'ok' } };
        const other = { ...record, id: 'proc_2', workspaceId: 'ws_other', name: 'Not mine' };
        const ports = {
            services: { list: () => [] }, settings: { workspaceValues: () => ({}) },
            registry: { defaultAgentOf: () => null, workspaceMcpOff: () => [], listAgents: () => [], listWorkspaces: () => [] },
            processes: { kept: () => [record, other] },
        } as unknown as SourcePorts;
        expect(elementSourcesFor(ports, WS).processes).toEqual([{ name: 'Queue worker', workspaceId: WS, command: 'php artisan queue:work', cwd: `${ROOT}/repos/app`, restart: 'always', schedule: { cron: '0 3 * * *', kind: 'command' } }]);
    });
});

describe('a fresh clone’s processes', () => {
    const file = (name: string, value: unknown) => ({ path: `.processes/${name}.json`, text: JSON.stringify(value) });
    const saved = (p: ProcessSource) => processesDeclaration([p], WS, ROOT).files[0]!.value as Record<string, unknown>;
    const rig = (existing: ProcessSource[] = [], agents: Record<string, string> = { lift: 'lift@acme' }) => {
        const kept: { workspaceId: string; workspacePath: string; name: string; command: string; folder?: string | undefined; restart: string; schedule?: unknown; enabled?: boolean | undefined }[] = [];
        const ports: ProcessPorts = {
            list: () => existing,
            keep: async (input) => { kept.push(input); return input; },
            agentAddressOf: (_workspaceId, name) => agents[name] ?? null,
        };
        return { ports, kept };
    };
    const run = (files: { path: string; text: string }[], ports: ProcessPorts, trusted = true) => restoreProcesses(files, { workspaceId: 'ws_clone', workspacePath: '/c/acme', ports, trusted });

    it('are KEPT STOPPED, in the clone’s own folder, by name from the file, never started', async () => {
        const { ports, kept } = rig();
        const out = await run([file('queue-worker', saved(worker()))], ports);
        expect(out.created).toEqual(['.processes/queue-worker.json']);
        expect(kept).toEqual([{ workspaceId: 'ws_clone', workspacePath: '/c/acme', name: 'queue-worker', command: 'php artisan queue:work', folder: 'repos/app', restart: 'always' }]);
    });

    it('a scheduled task is kept PAUSED; an agent nudge’s agent is found by name in the clone', async () => {
        const { ports, kept } = rig();
        await run([file('nightly-dump', saved(nightly())), file('morning-nudge', saved(nudge()))], ports);
        expect(kept[0]).toMatchObject({ name: 'nightly-dump', restart: 'never', enabled: false, schedule: { cron: '0 3 * * *', kind: 'command' } });
        expect(kept[1]).toMatchObject({ name: 'morning-nudge', enabled: false, schedule: { cron: '0 8 * * 1-5', kind: 'agent-nudge', prompt: 'Check the queue.', agent: 'lift@acme' } });
    });

    it('waits for the workspace’s trust, and nothing is kept before it', async () => {
        const { ports, kept } = rig();
        const out = await run([file('queue-worker', saved(worker()))], ports, false);
        expect(out.waiting).toEqual([{ file: '.processes/queue-worker.json', commands: ['php artisan queue:work'] }]);
        expect(out.created).toEqual([]);
        expect(kept).toEqual([]);
    });

    it('an id, wanted, a last run or a cwd put in a file is dropped and named, and the process is still kept stopped', async () => {
        const { ports, kept } = rig();
        const hand = { ...saved(nightly()), id: 'proc_x', wanted: true, cwd: 'C:/x', schedule: { cron: '0 3 * * *', kind: 'command', lastRunAt: 5, lastRunStatus: 'ok' } };
        const out = await run([file('nightly-dump', hand)], ports);
        expect(out.ignored).toEqual([{ file: '.processes/nightly-dump.json', keys: ['cwd', 'id', 'schedule.lastRunAt', 'schedule.lastRunStatus', 'wanted'] }]);
        expect(kept[0]).toMatchObject({ enabled: false });
        expect(kept[0]).not.toHaveProperty('wanted');
    });

    it('a folder that leaves the workspace is refused by the cwd rule; the good one beside it is kept', async () => {
        const { ports, kept } = rig();
        const bad = (folder: string, name: string) => file(name, { ...saved(worker()), folder });
        const out = await run([bad('../../x', 'climbs'), bad('/data', 'rooted'), bad('C:\\x', 'drive'), bad('repos/app', 'fine')], ports);
        expect(out.refused.map((r) => r.file)).toEqual(['.processes/climbs.json', '.processes/rooted.json', '.processes/drive.json']);
        for (const r of out.refused) expect(r.reason, r.file).toContain('cwd');
        expect(kept.map((k) => k.name)).toEqual(['fine']);
    });

    it('refuses a file that cannot run, in words: not JSON, no command, a restart policy nobody has, a cron nobody can read, an unknown agent, a key that is not saved', async () => {
        const { ports, kept } = rig();
        const base = saved(worker());
        const out = await run([
            { path: '.processes/broken.json', text: '{ nope' },
            file('nocommand', { ...base, command: '' }),
            file('badrestart', { ...base, restart: 'sometimes' }),
            file('badcron', saved(nightly({ schedule: { cron: 'whenever', kind: 'command' } }))),
            file('noagent', saved(nudge({ schedule: { cron: '0 8 * * *', kind: 'agent-nudge', prompt: 'p', agent: 'ghost@acme' } }))),
            file('password', { ...base, password: 'hunter2' }),
        ], ports);
        expect(out.refused.map((r) => r.file)).toEqual(['.processes/broken.json', '.processes/nocommand.json', '.processes/badrestart.json', '.processes/badcron.json', '.processes/noagent.json', '.processes/password.json']);
        expect(out.refused[0]!.reason).toContain('not valid JSON');
        expect(out.refused[3]!.reason).toContain('whenever');
        expect(out.refused[4]!.reason).toContain('ghost');
        expect(out.refused[5]!.reason).toContain('password');
        expect(kept).toEqual([]);
    });

    it('one already here with that name is left alone: the same is present, a different one is reported and not overwritten', async () => {
        const same = rig([worker({ name: 'queue-worker', cwd: '/c/acme/repos/app' })]);
        expect((await run([file('queue-worker', saved(worker()))], same.ports)).present).toEqual(['.processes/queue-worker.json']);
        const differs = rig([worker({ name: 'queue-worker', command: 'php artisan horizon', cwd: '/c/acme/repos/app' })]);
        const out = await run([file('queue-worker', saved(worker()))], differs.ports);
        expect(out.differs).toEqual(['.processes/queue-worker.json']);
        expect(differs.kept).toEqual([]);
    });

    it('CONTROL: an empty folder keeps nothing', async () => {
        const { ports } = rig();
        expect(await run([], ports)).toEqual({ created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] });
    });
});
