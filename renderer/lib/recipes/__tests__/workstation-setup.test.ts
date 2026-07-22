import { describe, it, expect, vi } from 'vitest';
import type { api as apiType } from '../../genie';
import { RecipeEngine } from '../engine';
import {
    workstationSetupRecipe,
    buildAgentSettingsPatch,
    SETUP_COMPLETE_PATH,
    WORKSTATION_SETUP_RECIPE_ID,
} from '../workstation-setup';
import type { RecipeStep, TaskStepSpec, TerminalStepSpec, BrowserStepSpec } from '../types';

/** A fake `api()` accessor whose settings.set + remote.request are spies. */
function fakeApi() {
    const settingsSet = vi.fn(async (p: unknown) => p);
    const remoteRequest = vi.fn(async () => ({ ok: true }));
    const openExternal = vi.fn(async () => undefined);
    const fn = (() => ({
        settings: { set: settingsSet, get: vi.fn(async () => ({})) },
        remote: { request: remoteRequest },
        shell: { openExternal },
    })) as unknown as typeof apiType;
    return { fn, settingsSet, remoteRequest };
}

const stepById = (id: string): RecipeStep => {
    const s = workstationSetupRecipe.steps.find((x) => x.id === id);
    if (!s) throw new Error(`no step ${id}`);
    return s;
};

describe('workstationSetupRecipe — shape', () => {
    it('is the workstation-setup recipe with the agent → github → complete flow', () => {
        expect(workstationSetupRecipe.id).toBe(WORKSTATION_SETUP_RECIPE_ID);
        expect(workstationSetupRecipe.steps.map((s) => s.id)).toEqual([
            'default-agent',
            'enabled-agents',
            'agent-flags',
            'persist-agents',
            'gh-device',
            'gh-login',
            'gh-setup-git',
            'complete',
        ]);
    });

    it('picks the default agent (single) and enables agents (multi)', () => {
        const def = stepById('default-agent');
        const enabled = stepById('enabled-agents');
        expect(def.type).toBe('choice');
        expect(enabled.type).toBe('choice');
        expect(enabled.type === 'choice' && enabled.multi).toBe(true);
        // Every agent the launch pipeline knows is offered.
        expect(def.type === 'choice' && def.options.map((o) => o.value)).toEqual([
            'claude',
            'codex',
            'custom',
        ]);
    });

    it('collects per-agent flags in a non-blocking form (no required fields)', () => {
        const flags = stepById('agent-flags');
        expect(flags.type).toBe('form');
        if (flags.type !== 'form') throw new Error('expected form');
        expect(flags.fields.map((f) => f.key)).toEqual([
            'agent_flags_claude',
            'agent_flags_codex',
            'agent_flags_custom',
        ]);
        // Optional — nothing required, so an empty form never blocks the wizard.
        expect(flags.fields.some((f) => f.required)).toBe(false);
    });

    it('runs the gh device-flow login in an embedded (host) terminal', () => {
        const login = stepById('gh-login') as TerminalStepSpec;
        expect(login.type).toBe('terminal');
        expect(login.command).toBe('gh');
        expect(login.args).toEqual([
            'auth',
            'login',
            '--hostname',
            'github.com',
            '--git-protocol',
            'https',
            '--web',
        ]);
    });

    it('opens the GitHub device page in the LOCAL browser before login', () => {
        const device = stepById('gh-device') as BrowserStepSpec;
        expect(device.type).toBe('browser');
        expect(device.url).toBe('https://github.com/login/device');
        // The browser step is ordered BEFORE the gh-login terminal, so the page is
        // already open when the terminal shows the one-time code.
        const ids = workstationSetupRecipe.steps.map((s) => s.id);
        expect(ids.indexOf('gh-device')).toBeLessThan(ids.indexOf('gh-login'));
    });

    it('registers git credentials and verifies auth (setup-git && status)', () => {
        const setupGit = stepById('gh-setup-git') as TerminalStepSpec;
        expect(setupGit.type).toBe('terminal');
        const joined = [setupGit.command, ...(setupGit.args ?? [])].join(' ');
        expect(joined).toContain('gh auth setup-git');
        expect(joined).toContain('gh auth status');
    });
});

describe('buildAgentSettingsPatch — agent choices → genie settings', () => {
    it('writes agent_flags_* + agent_default + agent_enabled (never agent_command_*)', () => {
        const patch = buildAgentSettingsPatch({
            defaultAgent: 'codex',
            enabledAgents: ['claude', 'codex'],
            flags: { claude: '--dangerously-skip-permissions', codex: '--yolo', custom: '' },
        });
        expect(patch).toEqual({
            agent_flags_claude: '--dangerously-skip-permissions',
            agent_flags_codex: '--yolo',
            agent_flags_custom: '',
            agent_default: 'codex',
            agent_enabled: JSON.stringify(['claude', 'codex']),
        });
        // NON-CLOBBER: the wizard never overwrites a user's custom launch command.
        expect(Object.keys(patch).some((k) => k.startsWith('agent_command_'))).toBe(false);
    });

    it('always includes the default agent in the enabled set and falls back to claude', () => {
        const patch = buildAgentSettingsPatch({
            defaultAgent: 'codex',
            enabledAgents: ['claude'],
            flags: {},
        });
        // The default (codex) is prepended when it isn't already in the chosen set.
        expect(JSON.parse(String(patch.agent_enabled))).toEqual(['codex', 'claude']);

        const fallback = buildAgentSettingsPatch({ enabledAgents: [], flags: {} });
        expect(fallback.agent_default).toBe('claude');
        expect(JSON.parse(String(fallback.agent_enabled))).toEqual(['claude']);
    });

    it('drops unknown agent ids and trims flag whitespace', () => {
        const patch = buildAgentSettingsPatch({
            defaultAgent: 'claude',
            enabledAgents: ['claude', 'bogus'],
            flags: { claude: '  --dangerously-skip-permissions  ' },
        });
        expect(patch.agent_flags_claude).toBe('--dangerously-skip-permissions');
        expect(JSON.parse(String(patch.agent_enabled))).toEqual(['claude']);
    });
});

describe('workstationSetupRecipe — effects', () => {
    it('persist-agents writes the derived settings patch to the host', async () => {
        const { fn, settingsSet } = fakeApi();
        const e = new RecipeEngine(workstationSetupRecipe, { workspaceId: '__genie_setup__' });
        e.set('default-agent', 'claude');
        e.set('enabled-agents', ['claude', 'codex']);
        e.set('agent_flags_claude', '--dangerously-skip-permissions');
        e.set('agent_flags_codex', '');
        e.set('agent_flags_custom', '');
        const ctx = e.buildContext(fn);

        await (stepById('persist-agents') as TaskStepSpec).run(ctx);

        expect(settingsSet).toHaveBeenCalledTimes(1);
        expect(settingsSet).toHaveBeenCalledWith(
            buildAgentSettingsPatch({
                defaultAgent: 'claude',
                enabledAgents: ['claude', 'codex'],
                flags: {
                    claude: '--dangerously-skip-permissions',
                    codex: '',
                    custom: '',
                },
            }),
        );
    });

    it('the final task marks setup complete via the host completion endpoint', async () => {
        const { fn, remoteRequest } = fakeApi();
        const e = new RecipeEngine(workstationSetupRecipe, { workspaceId: '__genie_setup__' });
        const ctx = e.buildContext(fn);

        await (stepById('complete') as TaskStepSpec).run(ctx);

        expect(remoteRequest).toHaveBeenCalledWith(SETUP_COMPLETE_PATH, { method: 'POST' });
    });

    it('drives the engine start → finish through per-step success', () => {
        const e = new RecipeEngine(workstationSetupRecipe);
        for (let i = 0; i < workstationSetupRecipe.steps.length - 1; i++) {
            e.markSuccess();
            expect(e.next()).toBe(true);
        }
        expect(e.isLastStep).toBe(true);
        e.markSuccess();
        expect(e.complete()).toBe(true);
    });
});
