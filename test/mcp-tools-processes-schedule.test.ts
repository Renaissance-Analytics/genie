import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { processTools } from '../src/main/mcp-tools-processes.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * AN AGENT SCHEDULES A TASK THROUGH `processes` (Genie 1's `manageProcess` create with `schedule` / `scheduleKind`, its
 * `run-now`, `enable` and `disable` — main/mcp/host-tools.ts:695-962 at v0.7.0-beta.342). The person approves it first and
 * sees the recurrence — "It will keep running on this schedule … until you disable it" (approveScheduledTask, :583-605);
 * approved, it is ENABLED, as Genie 1 armed an approved task. A recurrence Genie cannot read, or a nudge with no prompt or
 * no agent, is refused BEFORE the person is asked. `run-now` is for a scheduled task only.
 */

const statuses = new Map<string, ProcessStatus>();
const started: ProcessSpec[] = [];
const supervisor = {
    start: (spec: ProcessSpec): ProcessStatus => { started.push(spec); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }; statuses.set(s.id, s); return s; },
    stop: () => true,
    forget: (id: string) => statuses.delete(id),
    list: (w?: string) => [...statuses.values()].filter((s) => w === undefined || s.workspaceId === w),
    status: (id: string) => statuses.get(id) ?? null,
    onChange: () => () => {},
};

let dir: string;
let book: ProcessBook;
let tools: Registration[];
const asks: string[] = [];
let verdict: 'allowed' | 'denied' = 'allowed';
const caller: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: '' };

async function call(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'processes')!;
    const r = await reg.handler({ ...args, terminalId: 't' }, { server: 'genie', tool: 'processes', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-sched-'));
    await mkdir(join(dir, 'example'), { recursive: true });
    (caller as { workspacePath: string }).workspacePath = join(dir, 'example');
    statuses.clear();
    started.length = 0;
    asks.length = 0;
    verdict = 'allowed';
    book = await ProcessBook.open(dir, { supervisor, envFor: () => ({}), asleep: () => false });
    const scheduler = new ProcessScheduler({ book, supervisor, envFor: () => ({}), asleep: () => false, nudge: () => true, now: Date.now, schedule: () => () => {} });
    tools = processTools({
        resolveCaller: () => caller,
        approve: async (_c, _a, detail) => { asks.push(detail); return verdict; },
        processes: { book, logs: () => null, runNow: (id) => scheduler.runNow(id) },
    });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('processes: a scheduled task', () => {
    it('add with a schedule asks the person, naming the recurrence; approved, it is kept ENABLED and nothing runs until it is due', async () => {
        const r = await call({ action: 'add', name: 'nightly report', command: 'npm run report', schedule: '0 3 * * *' });
        expect(r.isError).toBe(false);
        expect(asks).toEqual([expect.stringMatching(/0 3 \* \* \*.*keep running on this schedule.*until you pause it/s)]);
        expect(started).toEqual([]);
        expect(r.json.process).toMatchObject({ name: 'nightly report', schedule: { cron: '0 3 * * *', kind: 'command', enabled: true } });
    });

    it('a nudge: needs a prompt and an agent; kept with both', async () => {
        expect((await call({ action: 'add', name: 'standup', schedule: '0 9 * * 1-5', scheduleKind: 'agent-nudge', agent: 'atlas@example' })).json.error).toMatch(/prompt/);
        expect((await call({ action: 'add', name: 'standup', schedule: '0 9 * * 1-5', scheduleKind: 'agent-nudge', prompt: 'post the standup' })).json.error).toMatch(/agent/);
        expect(asks).toEqual([]);
        const r = await call({ action: 'add', name: 'standup', schedule: '0 9 * * 1-5', scheduleKind: 'agent-nudge', prompt: 'post the standup', agent: 'atlas@example' });
        expect(r.json.process.schedule).toMatchObject({ kind: 'agent-nudge', prompt: 'post the standup', agent: 'atlas@example' });
    });

    it('a recurrence Genie cannot read is refused BEFORE anyone is asked; a denial keeps nothing', async () => {
        expect((await call({ action: 'add', name: 'x', command: 'npm test', schedule: 'every day' })).json.error).toMatch(/not a schedule Genie can evaluate/);
        expect(asks).toEqual([]);
        verdict = 'denied';
        expect((await call({ action: 'add', name: 'x', command: 'npm test', schedule: '0 3 * * *' })).isError).toBe(true);
        expect(book.kept()).toEqual([]);
    });

    it('run-now runs it once; disable pauses it and enable arms it again; run-now on an ordinary process is refused', async () => {
        await call({ action: 'add', name: 'nightly report', command: 'npm run report', schedule: '0 3 * * *' });
        expect((await call({ action: 'run-now', process: 'nightly report' })).isError).toBe(false);
        expect(started.map((s) => [s.command, s.restart])).toEqual([['npm run report', 'never']]);
        expect((await call({ action: 'disable', process: 'nightly report' })).json.process.schedule.enabled).toBe(false);
        expect((await call({ action: 'enable', process: 'nightly report' })).json.process.schedule.enabled).toBe(true);
        await book.create({ workspaceId: 'example', workspacePath: caller.workspacePath, name: 'queue', command: 'php artisan queue:work', restart: 'on-failure' });
        expect((await call({ action: 'run-now', process: 'queue' })).json.error).toMatch(/no schedule/);
    });
});
