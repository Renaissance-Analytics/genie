import { describe, expect, it } from 'vitest';
import {
    ADD_WORKSPACE_SOURCES,
    FIRST_RUN_STEPS,
    canFinishFirstRun,
    containerRepoPlan,
    nextIncompleteFirstRunStep,
    workspaceFolderName,
    workspacePathPreview,
    workspaceSlug,
    scannedWorkspaceAction,
    FIRST_AGENT_PRESETS,
    firstAgentDriver,
} from '../workspace-onboarding';

it('registers a folder that is already a workspace instead of wrapping it again', () => {
    expect(scannedWorkspaceAction({ has_project_json: true })).toBe('register');
    expect(scannedWorkspaceAction({ has_project_json: false })).toBe('convert');
});

describe('managed workspace entry points', () => {
    /**
     * genie#431 — CREATING is not CONVERTING. "New workspace" used to return
     * `{ mode: 'local' }`, which is the same route an import takes, so the
     * inspect-and-convert wizard opened on a workspace that does not exist yet
     * and demanded a folder to upgrade. There was no way to make an empty one.
     */
    it('separates making a workspace from adopting one', () => {
        expect(ADD_WORKSPACE_SOURCES.map((source) => source.id)).toEqual([
            'new',
            'gapp',
            'local',
            'git',
            'tynn',
        ]);
    });

    it('groups the sources by whether they MAKE a workspace or ADOPT one', () => {
        // The distinction the fix turns on, said out loud on the screen it was
        // missing from — and the reason the picker can show five cards without
        // looking like a list of five unrelated buttons.
        const byGroup = (group: string) =>
            ADD_WORKSPACE_SOURCES.filter((s) => s.group === group).map((s) => s.id);
        expect(byGroup('create')).toEqual(['new', 'gapp']);
        expect(byGroup('adopt')).toEqual(['local', 'git', 'tynn']);
    });

    // WHERE each source goes now lives in `./add-workspace` — a source no
    // longer picks a ROUTE, it supplies whichever of Identity / Content / Links
    // it happens to know, and the flow asks for the rest. See
    // add-workspace.test.ts.

    it('never offers a plain-folder workspace', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/simple|plain folder/i);
    });

    /**
     * genie#432 — the picker is the first screen of the product for a new user.
     * It must not teach the storage format to explain what a workspace is.
     */
    it('describes the sources without format vocabulary', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/envelope|upgrade|\.agi/i);
    });
});

describe('what a new workspace is called', () => {
    it('derives the folder from the name the user typed', () => {
        expect(workspaceSlug('Acme Storefront')).toBe('acme-storefront');
        expect(workspaceSlug('  Tynn.ai  ')).toBe('tynn.ai');
        expect(workspaceSlug('My_Weird  Name!!')).toBe('my-weird-name');
        expect(workspaceFolderName('Acme Storefront')).toBe('acme-storefront.agi');
    });

    it('does not double the suffix when the name already carries one', () => {
        expect(workspaceFolderName('tynn.ai.agi')).toBe('tynn.ai.agi');
    });

    it('has nothing to name when nothing was typed', () => {
        expect(workspaceSlug('   ')).toBe('');
        expect(workspaceFolderName('   ')).toBe('');
    });

    /**
     * The form shows the path before it makes it, so someone can see where the
     * folder is going while they are still typing its name. The renderer has no
     * `node:path`, and the separator has to match the machine it is describing —
     * a Windows parent joined with `/` is a path that reads as wrong to the only
     * person who can check it.
     */
    it('previews the destination in the separator the parent already uses', () => {
        expect(workspacePathPreview('C:\\Projects', 'acme.agi')).toBe('C:\\Projects\\acme.agi');
        expect(workspacePathPreview('/home/wish/code', 'acme.agi')).toBe('/home/wish/code/acme.agi');
        expect(workspacePathPreview('C:\\Projects\\', 'acme.agi')).toBe('C:\\Projects\\acme.agi');
        expect(workspacePathPreview('/home/wish/code/', 'acme.agi')).toBe('/home/wish/code/acme.agi');
    });
});

describe('the container repository', () => {
    /**
     * genie#431 — the container repo is a CONSEQUENCE of GitHub being connected.
     * It is not a mode the user picks, and it is never a precondition: a
     * workspace can always be created, GitHub or no GitHub.
     */
    it('is created whenever GitHub is connected — no question asked', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: true,
            owner: 'acme',
            slug: 'storefront',
        })).toEqual({ kind: 'github', owner: 'acme', repo: 'storefront.agi' });
    });

    it('falls back to this machine only when GitHub is not connected', () => {
        expect(containerRepoPlan({
            githubConnected: false,
            githubCanProvision: false,
            owner: '',
            slug: 'storefront',
        })).toEqual({ kind: 'local-only', reason: 'not-connected' });
    });

    it('falls back rather than failing when the App cannot create repositories', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: false,
            owner: 'acme',
            slug: 'storefront',
        })).toEqual({ kind: 'local-only', reason: 'missing-permission' });
    });

    it('has no repository to name before the workspace is named', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: true,
            owner: 'acme',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'unnamed' });
    });

    /**
     * The ACCOUNT decides first, and the name only decides whether there is a
     * repository name to show. Answering `unnamed` for a disconnected account
     * made the form say nothing at all until something was typed — so the one
     * fact a user needs before they start ("this stays on your machine") only
     * appeared once they had finished.
     */
    it('knows GitHub is absent before a single character is typed', () => {
        expect(containerRepoPlan({
            githubConnected: false,
            githubCanProvision: false,
            owner: '',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'not-connected' });
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: false,
            owner: 'acme',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'missing-permission' });
    });
});

// WHAT a Tynn project resolves to — its container, its repositories, or an
// empty workspace — moved to `./tynn-import` (`tynnImportContent`), where the
// import route reads it. See tynn-import.test.ts.

describe('first-run onboarding contract', () => {
    /**
     * REPLACED, not loosened. This case used to pin the seven-step order — welcome, drivers,
     * tynn, github, verify, workspace, ready — and it was right for the flow it was written
     * against. P7 cuts first run to two steps, so the contract it pins is a different one; the
     * cases in "FIRST RUN IS TWO STEPS" below are its replacement, and they say what was checked
     * before each deleted step was removed.
     */
    it('still refuses to finish with no workspace', () => {
        // The one gate that survives untouched: a workstation with no workspace has nothing to
        // run an agent in, so finishing would land the user on an empty Deck.
        expect(canFinishFirstRun({ existingWorkspaceCount: 2, setupComplete: true })).toBe(true);
        expect(canFinishFirstRun({ existingWorkspaceCount: 0, setupComplete: true })).toBe(false);
    });

    it('resumes at the first incomplete required step', () => {
        expect(nextIncompleteFirstRunStep({})).toBe('workspace');
        expect(nextIncompleteFirstRunStep({ workspace: true })).toBe('agent');
        expect(nextIncompleteFirstRunStep({ workspace: true, agent: true })).toBeNull();
    });
});

describe('FIRST RUN IS TWO STEPS', () => {
    /**
     * Seven gates, with Tynn sign-in and GitHub connect IN FRONT of seeing an agent work.
     * The plan's target: *"two steps: pick a folder; Genie verifies the one driver it needs and
     * starts one agent with a first prompt pre-filled… Target: first agent reply in under 2
     * minutes, 2 decisions."*
     *
     * ## Nothing is lost by deleting the other five, and that was checked rather than assumed
     *
     *  - **Tynn** — `master.tsx` already refuses to render the app signed out (`authChecked &&
     *    !signedIn` → `SignInPrompt`). The onboarding step was asking for something the app
     *    cannot start without, which makes it a second door on the same wall.
     *  - **GitHub** — already optional, and `GitHubConnect` lives in Settings.
     *  - **Toolchain** — `ToolchainSetupWizard` is mounted in `settings.tsx`, and the one case
     *    that actually blocks a first agent (no driver on the machine) is verified in step 2
     *    where it can be acted on.
     *  - **Genie OS** — its workspace is prepared automatically; the optional GitHub backup is
     *    `syncGenieOs`, which `settings.tsx` already calls.
     *  - **Welcome** — a page whose only control was "Get started".
     *
     * Every one of those was confirmed present elsewhere in source before the step was removed.
     * A deferred prompt that does not exist is not deferred, it is deleted.
     */
    it('is exactly two steps, in order', () => {
        expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual(['workspace', 'agent']);
    });

    it('gates on both, because neither is optional', () => {
        // "Optional" meant a step the finish gate skips. Two steps and one of them optional
        // would be one step wearing a disguise.
        expect(FIRST_RUN_STEPS.every((s) => !s.optional)).toBe(true);
    });

    it('asks for the FOLDER first — the only thing Genie cannot guess', () => {
        expect(FIRST_RUN_STEPS[0]!.id).toBe('workspace');
        expect(nextIncompleteFirstRunStep({})).toBe('workspace');
    });

    it('moves to the agent once a workspace exists', () => {
        expect(nextIncompleteFirstRunStep({ workspace: true })).toBe('agent');
    });

    it('is finished when both are done', () => {
        expect(nextIncompleteFirstRunStep({ workspace: true, agent: true })).toBeNull();
    });
});

describe('FIRST_AGENT_PRESETS', () => {
    /**
     * *"'New agent' offers three presets with real first prompts… each instructing the agent to
     * finish with `imDone` + a handoff — so first run teaches the whole loop by construction."*
     *
     * The `imDone` instruction is the load-bearing part. A first agent that answers and stops
     * teaches that Genie is a chat window; one that files a handoff teaches the loop the whole
     * product is built on, on the very first run.
     */
    it('offers three, each with a real prompt', () => {
        expect(FIRST_AGENT_PRESETS).toHaveLength(3);
        for (const preset of FIRST_AGENT_PRESETS) {
            expect(preset.label.length).toBeGreaterThan(3);
            expect(preset.prompt.length).toBeGreaterThan(30);
        }
    });

    it('names the three the plan specifies', () => {
        const prompts = FIRST_AGENT_PRESETS.map((p) => p.prompt.toLowerCase());
        expect(prompts.some((p) => p.includes('orientation'))).toBe(true);
        expect(prompts.some((p) => p.includes('failing test'))).toBe(true);
        expect(prompts.some((p) => p.includes('commits'))).toBe(true);
    });

    it('teaches the LOOP: every preset ends with imDone and a handoff', () => {
        for (const preset of FIRST_AGENT_PRESETS) {
            expect(preset.prompt).toContain('imDone');
            expect(preset.prompt.toLowerCase()).toContain('handoff');
        }
    });

    it('has distinct ids, so a choice can be recorded', () => {
        const ids = FIRST_AGENT_PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('firstAgentDriver', () => {
    /**
     * "Genie verifies the ONE driver it needs" — not every driver the machine could have.
     *
     * The old flow asked which of twenty-one TUIs to enable before anything had run, which is a
     * question nobody can answer on first launch and a decision Settings owns anyway.
     */
    it('prefers the configured default when it is installed', () => {
        expect(firstAgentDriver({ configured: 'codex', installed: ['claude', 'codex'] })).toEqual({
            ready: true,
            driver: 'codex',
        });
    });

    it('falls back to the first INSTALLED driver when the default is not there', () => {
        // Better than refusing: the machine demonstrably has something that can run.
        expect(firstAgentDriver({ configured: 'codex', installed: ['claude'] })).toEqual({
            ready: true,
            driver: 'claude',
        });
    });

    it('prefers claude when nothing is configured', () => {
        expect(firstAgentDriver({ configured: null, installed: ['aider', 'claude'] })).toEqual({
            ready: true,
            driver: 'claude',
        });
    });

    it('reports NOT READY when the machine has no driver at all', () => {
        // The one case that genuinely blocks a first agent — and the reason the toolchain check
        // survives at all, now where it can be acted on instead of as a gate in front of
        // everything.
        expect(firstAgentDriver({ configured: 'claude', installed: [] })).toEqual({ ready: false });
    });
});
