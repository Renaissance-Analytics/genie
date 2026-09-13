import { describe, expect, it } from 'vitest';
import { SYSTEM_WORKSPACE_ID, type TerminalSpec } from '../genie';
import {
    draftFromSpec,
    draftProblems,
    draftToCreate,
    draftToPatch,
    emptyProcessDraft,
    formatEnvText,
    parseEnvText,
    processCard,
    processSpecsOf,
    restartAfterSave,
    splitProcessTabs,
    type ProcessDraft,
} from '../process-manager';

/**
 * THE PROCESSES MODAL — every judgement it renders from.
 *
 * Background processes used to live in an expanding block in the sidebar: a row
 * per process with icon-only buttons, a hover log, a right-click menu for Edit,
 * and a form that could set only the command, label, directory, shell and
 * schedule. The owner asked for them to move into a modal built like the Site
 * Manager, with every property a process has available and a UX that is not
 * sloppy. The renderer has no DOM harness, so everything the modal decides is
 * here, and the component is wiring.
 *
 * What "every property" means for a process spec: label, command, where it runs
 * (a repo, the workspace root, or — for the System Workspace — any directory),
 * shell, environment, whether it starts with Genie, whether it restarts when it
 * exits, and a schedule (including an agent-nudge task's prompt).
 */

const WS = { id: 'ws1', path: '/work/acme.agi', project_name: 'Acme' };
const SYSTEM = { id: SYSTEM_WORKSPACE_ID, path: '/home/me', project_name: 'System' };
const NOW = 1_800_000_000_000;

function spec(over: Partial<TerminalSpec> & { meta?: TerminalSpec['meta'] } = {}): TerminalSpec {
    return {
        id: 'p1',
        workspace_id: 'ws1',
        label: 'Queue worker',
        cwd: '/work/acme.agi/repos/tynn',
        shell: null,
        args: [],
        env: {},
        type: 'process',
        sort_order: 0,
        created_at: '',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        ...over,
        meta: { command: 'php artisan queue:work', restart_on_exit: true, ...(over.meta ?? {}) },
    } as TerminalSpec;
}

const scheduled = (meta: TerminalSpec['meta'] = {}, over: Partial<TerminalSpec> = {}) =>
    spec({ ...over, meta: { schedule: '0 3 * * *', restart_on_exit: false, ...meta } });

describe('a service card', () => {
    it('offers Stop and Restart while it runs', () => {
        const card = processCard(spec(), WS, 'running', undefined, NOW);
        expect(card.kind).toBe('service');
        expect(card.tone).toBe('running');
        expect(card.statusLabel).toBe('Running');
        expect(card.actions).toEqual(['stop', 'restart', 'logs', 'edit', 'delete']);
    });

    it('offers Start, and no Restart, while it is stopped', () => {
        // Restart on a stopped process is Start with a misleading name.
        const card = processCard(spec(), WS, 'stopped', undefined, NOW);
        expect(card.tone).toBe('stopped');
        expect(card.actions).toEqual(['start', 'logs', 'edit', 'delete']);
    });

    it('says a crash is a crash, and offers to start it again', () => {
        for (const status of ['crashed', 'failed'] as const) {
            const card = processCard(spec(), WS, status, undefined, NOW);
            expect(card.tone).toBe('crashed');
            expect(card.statusLabel).toMatch(/crash|fail/i);
            expect(card.actions[0]).toBe('start');
        }
    });

    it('shows a restart in progress as starting, with Stop available', () => {
        const card = processCard(spec(), WS, 'restarting', undefined, NOW);
        expect(card.tone).toBe('starting');
        expect(card.actions).toEqual(['stop', 'logs', 'edit', 'delete']);
    });

    it('treats a process with no reported status as stopped', () => {
        expect(processCard(spec(), WS, undefined, undefined, NOW).tone).toBe('stopped');
    });

    it('names how it behaves, in words', () => {
        expect(processCard(spec({ meta: { autostart: true, restart_on_exit: true } }), WS, 'running', undefined, NOW).behaviours).toEqual([
            'Starts with Genie',
            'Restarts if it exits',
        ]);
        expect(
            processCard(spec({ meta: { autostart: false, restart_on_exit: false } }), WS, 'stopped', undefined, NOW)
                .behaviours,
        ).toEqual(['Runs only when you start it']);
    });
});

describe('a scheduled task card', () => {
    const info = { nextAt: NOW + 2 * 3_600_000, description: 'Daily at 03:00' };

    it('shows when it fires next and how the last fire went', () => {
        const card = processCard(
            scheduled({ last_run_at: NOW - 5 * 60_000, last_run_status: 'failed' }),
            WS,
            'stopped',
            info,
            NOW,
        );
        expect(card.kind).toBe('scheduled');
        expect(card.tone).toBe('armed');
        expect(card.schedule).toMatchObject({
            description: 'Daily at 03:00',
            next: 'in 2 hr',
            last: 'Failed 5 min ago',
            lastTone: 'failed',
        });
        expect(card.actions).toEqual(['run-now', 'disarm', 'logs', 'edit', 'delete']);
    });

    it('offers to arm a disabled task rather than disarm it', () => {
        const card = processCard(scheduled({}, { enabled: false }), WS, 'stopped', info, NOW);
        expect(card.tone).toBe('disarmed');
        expect(card.statusLabel).toMatch(/not firing/i);
        expect(card.actions).toEqual(['run-now', 'arm', 'logs', 'edit', 'delete']);
    });

    it('says a task awaits approval before anything else about it', () => {
        const card = processCard(scheduled({ schedule_pending_approval: true }), WS, 'stopped', { ...info, nextAt: null }, NOW);
        expect(card.tone).toBe('awaiting');
        expect(card.statusLabel).toMatch(/approval/i);
    });

    it('shows a fire in progress as running', () => {
        expect(processCard(scheduled(), WS, 'running', info, NOW).tone).toBe('running');
    });

    it('falls back to the expression when the Host has not described it yet', () => {
        const card = processCard(scheduled(), WS, 'stopped', undefined, NOW);
        expect(card.schedule?.description).toBe('0 3 * * *');
        expect(card.schedule?.next).toBe('Not scheduled');
    });

    it('shows what an agent-nudge task sends, since it runs no command', () => {
        const card = processCard(
            scheduled({ schedule_kind: 'agent-nudge', nudge_prompt: 'Check the queue.' }),
            WS,
            'stopped',
            info,
            NOW,
        );
        expect(card.schedule).toMatchObject({ kind: 'agent-nudge', nudgePrompt: 'Check the queue.' });
    });
});

describe('where a process runs, and what it runs with', () => {
    it('names a repo by its folder under repos/', () => {
        expect(processCard(spec(), WS, 'stopped', undefined, NOW).runsIn).toBe('repos/tynn');
    });

    it('names the workspace root in words', () => {
        expect(processCard(spec({ cwd: WS.path }), WS, 'stopped', undefined, NOW).runsIn).toBe('The workspace root');
    });

    it('shows a System process its absolute directory', () => {
        const s = spec({ workspace_id: null, cwd: '/srv/reverb', meta: { system: true } });
        expect(processCard(s, SYSTEM, 'stopped', undefined, NOW).runsIn).toBe('/srv/reverb');
    });

    it('shows the shell, or says it is the default', () => {
        expect(processCard(spec(), WS, 'stopped', undefined, NOW).shell).toBe('Default shell');
        expect(processCard(spec({ shell: 'pwsh' }), WS, 'stopped', undefined, NOW).shell).toBe('pwsh');
    });

    it('lists its environment', () => {
        const card = processCard(spec({ env: { APP_ENV: 'local', QUEUE: 'high' } }), WS, 'stopped', undefined, NOW);
        expect(card.env).toEqual([
            ['APP_ENV', 'local'],
            ['QUEUE', 'high'],
        ]);
    });
});

describe('tabs', () => {
    it('splits services from scheduled tasks, keeping their order', () => {
        const a = spec({ id: 'a' });
        const b = scheduled({}, { id: 'b' });
        const c = spec({ id: 'c' });
        const tabs = splitProcessTabs([a, b, c]);
        expect(tabs.services.map((s) => s.id)).toEqual(['a', 'c']);
        expect(tabs.scheduled.map((s) => s.id)).toEqual(['b']);
    });
});

describe('the environment field', () => {
    it('round-trips KEY=value lines', () => {
        const env = { APP_ENV: 'local', DSN: 'pgsql://u:p@h/db?x=1' };
        expect(parseEnvText(formatEnvText(env))).toEqual({ ok: true, env });
    });

    it('keeps everything after the FIRST = as the value', () => {
        expect(parseEnvText('URL=a=b=c')).toEqual({ ok: true, env: { URL: 'a=b=c' } });
    });

    it('ignores blank lines and # comments', () => {
        expect(parseEnvText('\n# a note\nA=1\n\n')).toEqual({ ok: true, env: { A: '1' } });
    });

    it('names the line it cannot read, rather than dropping it', () => {
        const parsed = parseEnvText('A=1\nnot a pair\n');
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toContain('not a pair');
    });

    it('refuses a key that is not a variable name', () => {
        expect(parseEnvText('1BAD=x').ok).toBe(false);
    });
});

describe('the form', () => {
    it('starts a new service with the defaults a service has always had', () => {
        const draft = emptyProcessDraft(WS);
        expect(draft).toMatchObject({ command: '', repo: '', dir: '', autostart: false, restartOnExit: true, schedule: '' });
    });

    it('starts a System process in its home directory', () => {
        expect(emptyProcessDraft(SYSTEM).dir).toBe('/home/me');
    });

    it('reads an existing process back into the form', () => {
        const s = spec({ shell: 'pwsh', env: { A: '1' }, meta: { autostart: true } });
        expect(draftFromSpec(s, WS)).toMatchObject({
            label: 'Queue worker',
            command: 'php artisan queue:work',
            repo: 'tynn',
            shell: 'pwsh',
            envText: 'A=1',
            autostart: true,
            restartOnExit: true,
            schedule: '',
            schedulePreset: '',
        });
    });

    it('opens a hand-written schedule straight into the custom field', () => {
        expect(draftFromSpec(scheduled({ schedule: '7 7 * * *' }), WS).schedulePreset).toBe('custom');
        expect(draftFromSpec(scheduled({ schedule: '0 3 * * *' }), WS).schedulePreset).toBe('0 3 * * *');
    });

    describe('problems, said before Save rather than after', () => {
        const ok = (): ProcessDraft => ({ ...emptyProcessDraft(WS), command: 'npm run dev' });

        it('accepts a complete draft', () => {
            expect(draftProblems(ok(), WS)).toEqual([]);
        });

        it('needs a command', () => {
            expect(draftProblems({ ...ok(), command: '   ' }, WS)).toEqual(['Enter the command to run.']);
        });

        it('needs a directory for a System process', () => {
            expect(draftProblems({ ...emptyProcessDraft(SYSTEM), command: 'x', dir: '' }, SYSTEM)).toEqual([
                'Choose the directory this process runs in.',
            ]);
        });

        it('needs five cron fields for a custom schedule', () => {
            const problems = draftProblems({ ...ok(), schedulePreset: 'custom', schedule: '0 3 * *' }, WS);
            expect(problems).toHaveLength(1);
            expect(problems[0]).toMatch(/5 fields/);
        });

        it('needs a readable environment', () => {
            expect(draftProblems({ ...ok(), envText: 'nope' }, WS)[0]).toContain('nope');
        });
    });

    describe('creating', () => {
        it('builds the spec a new service needs', () => {
            const created = draftToCreate(
                { ...emptyProcessDraft(WS), command: 'php artisan queue:work', repo: 'tynn', shell: 'pwsh', envText: 'A=1', autostart: true },
                WS,
            );
            expect(created).toEqual({
                workspace_id: 'ws1',
                label: 'php artisan queue:work',
                cwd: '/work/acme.agi/repos/tynn',
                shell: 'pwsh',
                env: { A: '1' },
                type: 'process',
                meta: { command: 'php artisan queue:work', autostart: true, restart_on_exit: true },
            });
        });

        it('names an unlabelled process after the first words of its command', () => {
            expect(draftToCreate({ ...emptyProcessDraft(WS), command: 'npm run dev -- --port 3000' }, WS).label).toBe(
                'npm run dev',
            );
        });

        it('runs at the workspace root when no repo is chosen', () => {
            expect(draftToCreate({ ...emptyProcessDraft(WS), command: 'x' }, WS).cwd).toBe(WS.path);
        });

        it('creates a System process unattached, in its chosen directory', () => {
            const created = draftToCreate({ ...emptyProcessDraft(SYSTEM), command: 'reverb', dir: '/srv' }, SYSTEM);
            expect(created.workspace_id).toBeNull();
            expect(created.cwd).toBe('/srv');
            expect(created.meta).toMatchObject({ system: true });
        });

        it('turns the service behaviours OFF for a scheduled task, whatever the switches say', () => {
            // A scheduled task is one-shot per fire: its schedule, not the
            // supervisor, decides when it runs again.
            const created = draftToCreate(
                { ...emptyProcessDraft(WS), command: 'x', schedulePreset: '0 3 * * *', schedule: '0 3 * * *', autostart: true, restartOnExit: true },
                WS,
            );
            expect(created.meta).toEqual({ command: 'x', autostart: false, restart_on_exit: false, schedule: '0 3 * * *' });
        });
    });

    describe('saving an edit', () => {
        it('changes nothing when nothing was changed', () => {
            const s = spec({ shell: 'pwsh', env: { A: '1' }, meta: { autostart: true } });
            const patch = draftToPatch(draftFromSpec(s, WS), s, WS);
            expect(patch.label).toBe(s.label);
            expect(patch.cwd).toBe(s.cwd);
            expect(patch.shell).toBe('pwsh');
            expect(patch.env).toEqual({ A: '1' });
            expect(patch.meta).toEqual(s.meta);
        });

        it('clears a schedule, turning the task back into a service', () => {
            const s = scheduled({ last_run_at: 5 });
            const patch = draftToPatch({ ...draftFromSpec(s, WS), schedulePreset: '', schedule: '' }, s, WS);
            expect(patch.meta?.schedule).toBeUndefined();
            // Run history is the task's record, and survives the edit.
            expect(patch.meta?.last_run_at).toBe(5);
        });

        it('keeps what the form does not show — an agent-nudge task keeps its target', () => {
            const s = scheduled({ schedule_kind: 'agent-nudge', nudge_agent_id: 'agent-9', nudge_prompt: 'hi' });
            const patch = draftToPatch({ ...draftFromSpec(s, WS), label: 'Renamed' }, s, WS);
            expect(patch.meta).toMatchObject({ schedule_kind: 'agent-nudge', nudge_agent_id: 'agent-9', nudge_prompt: 'hi' });
        });
    });

    describe('whether saving restarts it', () => {
        const s = spec();

        it('restarts a RUNNING service when something it runs with changed', () => {
            for (const change of [{ command: 'php artisan horizon' }, { repo: '' }, { shell: 'bash' }, { envText: 'A=2' }]) {
                const patch = draftToPatch({ ...draftFromSpec(s, WS), ...change }, s, WS);
                expect(restartAfterSave(s, patch, 'running'), JSON.stringify(change)).toBe(true);
            }
        });

        it('does NOT restart it for a rename', () => {
            const patch = draftToPatch({ ...draftFromSpec(s, WS), label: 'Renamed' }, s, WS);
            expect(restartAfterSave(s, patch, 'running')).toBe(false);
        });

        it('does not start a stopped one', () => {
            const patch = draftToPatch({ ...draftFromSpec(s, WS), command: 'other' }, s, WS);
            expect(restartAfterSave(s, patch, 'stopped')).toBe(false);
        });

        it('never restarts a scheduled task — nothing is running between fires', () => {
            const t = scheduled();
            const patch = draftToPatch({ ...draftFromSpec(t, WS), command: 'other' }, t, WS);
            expect(restartAfterSave(t, patch, 'running')).toBe(false);
        });
    });
});

describe('which processes belong to a workspace', () => {
    it('lists the workspace’s own processes, and nothing that is not a process', () => {
        const mine = spec({ id: 'mine' });
        const theirs = spec({ id: 'theirs', workspace_id: 'ws2' });
        const terminal = spec({ id: 'term', type: 'terminal' as TerminalSpec['type'] });
        expect(processSpecsOf([mine, theirs, terminal], WS).map((s) => s.id)).toEqual(['mine']);
    });

    it('gives the System Workspace its unattached System processes', () => {
        const system = spec({ id: 'sys', workspace_id: null, meta: { system: true } });
        const orphan = spec({ id: 'orphan', workspace_id: null });
        expect(processSpecsOf([system, orphan], SYSTEM).map((s) => s.id)).toEqual(['sys']);
        expect(processSpecsOf([system, orphan], WS)).toEqual([]);
    });
});
