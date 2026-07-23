import { describe, it, expect, vi } from 'vitest';
import type { api as apiType } from '../../genie';
import { RecipeEngine, resolveFields } from '../engine';
import {
    workstationSetupRecipe,
    buildAgentSettingsPatch,
    composeAgentFlags,
    agentFlagFields,
    enabledAgentIds,
    AGENT_FLAG_CATALOG,
    SETUP_COMPLETE_PATH,
    WORKSTATION_SETUP_RECIPE_ID,
} from '../workstation-setup';
import type { RecipeContext, RecipeStep, TaskStepSpec, TerminalStepSpec } from '../types';

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

/** A minimal RecipeContext seeded from a plain object (no engine needed). */
function ctxFrom(data: Record<string, unknown>): RecipeContext {
    const store = new Map(Object.entries(data));
    return {
        get: (k) => store.get(k),
        set: (k, v) => void store.set(k, v),
        api: (() => ({})) as unknown as typeof apiType,
    };
}

describe('workstationSetupRecipe — shape', () => {
    it('is the workstation-setup recipe with the agent → github → complete flow', () => {
        expect(workstationSetupRecipe.id).toBe(WORKSTATION_SETUP_RECIPE_ID);
        // The standalone `gh-device` browser step is GONE — the device page now opens
        // FROM the gh-login terminal (Bug 3), so the terminal (showing the one-time
        // code) and the browser appear together, correctly ordered.
        expect(workstationSetupRecipe.steps.map((s) => s.id)).toEqual([
            'default-agent',
            'enabled-agents',
            'agent-flags',
            'persist-agents',
            'gh-login',
            'gh-setup-git',
            'complete',
        ]);
    });

    it('collects per-agent flags in a DYNAMIC, non-blocking form', () => {
        const flags = stepById('agent-flags');
        expect(flags.type).toBe('form');
        if (flags.type !== 'form') throw new Error('expected form');
        // Bug 2: the fields are a FUNCTION of context (only the enabled agents), not
        // a fixed list — so a disabled agent never shows a flags control.
        expect(typeof flags.fields).toBe('function');
    });

    it('gh-login runs the device flow with the browser-open suppressed and does NOT auto-open a window (genie#48, genie-cloud#11)', () => {
        const login = stepById('gh-login') as TerminalStepSpec;
        expect(login.type).toBe('terminal');
        // Suppress gh's browser-open: on the headless host `--web` runs xdg-open and
        // prints an alarming "Failed opening a web browser" error (genie-cloud#11).
        // BROWSER=true makes the open a silent no-op; the owner reads the one-time
        // code + the device URL the pty prints and opens it themselves.
        const joined = [login.command, ...(login.args ?? [])].join(' ');
        expect(joined).toContain('BROWSER=true');
        expect(joined).toContain('gh auth login');
        expect(joined).toContain('--hostname github.com');
        expect(joined).toContain('--git-protocol https');
        expect(joined).toContain('--web');
        // The wizard must NOT open the GitHub window for the owner (genie#48).
        expect(login.openUrl).toBeUndefined();
        const ids = workstationSetupRecipe.steps.map((s) => s.id);
        expect(ids.indexOf('gh-login')).toBeLessThan(ids.indexOf('gh-setup-git'));
        expect(ids).not.toContain('gh-device');
    });

    it('registers git credentials and verifies auth (setup-git && status)', () => {
        const setupGit = stepById('gh-setup-git') as TerminalStepSpec;
        expect(setupGit.type).toBe('terminal');
        const joined = [setupGit.command, ...(setupGit.args ?? [])].join(' ');
        expect(joined).toContain('gh auth setup-git');
        expect(joined).toContain('gh auth status');
    });
});

describe('AGENT_FLAG_CATALOG — known safe flags per agent (Bug 2)', () => {
    it('offers the recommended flags as catalog entries', () => {
        expect(AGENT_FLAG_CATALOG.claude.map((f) => f.flag)).toContain(
            '--dangerously-skip-permissions',
        );
        expect(AGENT_FLAG_CATALOG.codex.map((f) => f.flag)).toContain('--yolo');
        // Every catalog entry is a fully-formed, self-describing checkbox option.
        for (const list of Object.values(AGENT_FLAG_CATALOG)) {
            for (const f of list) {
                expect(f.flag.startsWith('-')).toBe(true);
                expect(f.label.length).toBeGreaterThan(0);
                expect(f.description.length).toBeGreaterThan(0);
            }
        }
    });
});

describe('enabledAgentIds — only the agents chosen in the prior step', () => {
    it('reads the multi-choice, keeps known ids in catalog order, de-dupes', () => {
        expect(enabledAgentIds(ctxFrom({ 'enabled-agents': ['codex', 'claude'] }))).toEqual([
            'claude',
            'codex',
        ]);
        // A single (non-array) value and unknown ids are handled gracefully.
        expect(enabledAgentIds(ctxFrom({ 'enabled-agents': 'claude' }))).toEqual(['claude']);
        expect(enabledAgentIds(ctxFrom({ 'enabled-agents': ['bogus', 'claude'] }))).toEqual([
            'claude',
        ]);
        expect(enabledAgentIds(ctxFrom({}))).toEqual([]);
    });
});

describe('agentFlagFields — checkboxes only for enabled agents (Bug 2)', () => {
    it('renders a checkbox field per enabled agent with the catalog options', () => {
        const fields = agentFlagFields(['claude', 'codex']);
        expect(fields.map((f) => f.key)).toEqual(['agent_flags_claude', 'agent_flags_codex']);
        const claude = fields[0];
        expect(claude.type).toBe('checkboxes');
        expect((claude.options ?? []).map((o) => o.value)).toEqual(
            AGENT_FLAG_CATALOG.claude.map((f) => f.flag),
        );
    });

    it('shows only the enabled agents — a disabled agent gets no field', () => {
        const fields = agentFlagFields(['claude']);
        expect(fields.map((f) => f.key)).toEqual(['agent_flags_claude']);
    });

    it('falls back to a free-text field for an agent with no known flags (custom)', () => {
        const fields = agentFlagFields(['custom']);
        expect(fields).toHaveLength(1);
        expect(fields[0].key).toBe('agent_flags_custom');
        expect(fields[0].type).toBe('text');
    });

    it('the agent-flags step resolves its fields from the enabled-agents context', () => {
        const flags = stepById('agent-flags');
        if (flags.type !== 'form') throw new Error('expected form');
        const resolved = resolveFields(flags, ctxFrom({ 'enabled-agents': ['codex'] }));
        expect(resolved.map((f) => f.key)).toEqual(['agent_flags_codex']);
    });
});

describe('composeAgentFlags — checkbox selection → flag string', () => {
    it('joins a selected-flags array into a space-separated string', () => {
        expect(composeAgentFlags(['--yolo', '--full-auto'])).toBe('--yolo --full-auto');
    });
    it('de-dupes, drops blanks/non-strings, and preserves order', () => {
        expect(composeAgentFlags(['--a', '', '--a', '--b', 42 as unknown])).toBe('--a --b');
    });
    it('passes a plain string through trimmed (custom free-text)', () => {
        expect(composeAgentFlags('  --flag  ')).toBe('--flag');
    });
    it('treats undefined / null as no flags', () => {
        expect(composeAgentFlags(undefined)).toBe('');
        expect(composeAgentFlags(null)).toBe('');
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
    it('persist-agents composes checkbox selections into the settings patch', async () => {
        const { fn, settingsSet } = fakeApi();
        const e = new RecipeEngine(workstationSetupRecipe, { workspaceId: '__genie_setup__' });
        e.set('default-agent', 'claude');
        e.set('enabled-agents', ['claude', 'codex']);
        // Checkbox steps store the SELECTED flags as arrays — persist must compose them.
        e.set('agent_flags_claude', ['--dangerously-skip-permissions']);
        e.set('agent_flags_codex', []);
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
