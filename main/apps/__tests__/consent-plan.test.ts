import { describe, expect, it } from 'vitest';
import { buildConsentPlan, readConsent } from '../consent-plan';
import { validateAppManifest, type AppManifest } from '../manifest';
import { resolveAppRequirements } from '../requirements';
import type { ForceAnswer } from '../../mcp/protocol';

/**
 * The install-time consent prompt (Tynn #250).
 *
 * The owner's model is a mobile app store: the app declares what it wants, the
 * user consents at install, nothing else is reachable. Genie's consent primitive
 * is the OS-modal ForceTheQuestion — drawn OUTSIDE the app's window, which is what
 * makes it unfakeable — and that modal takes at most 4 questions of at most 4
 * options each. Fitting an app's declaration into that shape is a real decision
 * with real edge cases, so it is pure and tested rather than assembled inline
 * beside the I/O.
 *
 * Fail-closed is the through-line: the questions START unselected, an answer that
 * selects nothing grants nothing, and a dismissed modal installs nothing at all.
 */

const manifest = (over: Record<string, unknown> = {}): AppManifest => {
    const result = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting'] },
        ...over,
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

const noRequirements = resolveAppRequirements([], {
    installed: new Set<string>(),
    canInstall: () => true,
});

const answer = (header: string, selected: string[]): ForceAnswer => ({
    header,
    question: '',
    selected,
    note: '',
});

const plan = (m = manifest(), reqs = noRequirements) => buildConsentPlan(m, reqs);

describe('the questions the user is asked', () => {
    it('always asks whether to install at all', () => {
        // Even a capability-free app gets a workspace, hosting and an address on
        // this machine. That is worth a yes.
        const p = plan(manifest({ permissions: { scope: 'self', capabilities: [] } }));
        expect(p.questions[0]?.header).toBe('Install');
        expect(p.questions).toHaveLength(1);
    });

    it('names the app and where it will be served', () => {
        const text = plan().questions[0]?.question ?? '';
        expect(text).toContain('Example Trader');
        expect(text).toContain('trader.gen');
    });

    it('asks about permissions separately, and multi-select', () => {
        const permissions = plan().questions.find((q) => q.header === 'Permissions');
        expect(permissions?.multiSelect).toBe(true);
        expect(permissions?.options.map((o) => o.label)).toContain('Host sites and services');
    });

    it('asks nothing about permissions when the app wants none', () => {
        const p = plan(manifest({ permissions: { scope: 'self', capabilities: [] } }));
        expect(p.questions.some((q) => q.header === 'Permissions')).toBe(false);
    });

    it('asks about reach only when the app wants more than its own workspace', () => {
        expect(plan().questions.some((q) => q.header === 'Reach')).toBe(false);

        const wide = plan(
            manifest({ permissions: { scope: 'workstation', capabilities: ['hosting'] } }),
        );
        expect(wide.questions.some((q) => q.header === 'Reach')).toBe(true);
    });

    it('stays inside the modal’s limits however much an app asks for', () => {
        const greedy = plan(
            manifest({
                permissions: {
                    scope: 'workstation',
                    capabilities: [
                        'terminals',
                        'agents',
                        'processes',
                        'secrets',
                        'hosting',
                        'knowledge',
                        'files',
                        'notify',
                    ],
                },
            }),
        );

        expect(greedy.questions.length).toBeLessThanOrEqual(4);
        for (const q of greedy.questions) {
            expect(q.options.length, q.header).toBeGreaterThanOrEqual(2);
            expect(q.options.length, q.header).toBeLessThanOrEqual(4);
        }
    });

    it('gives the riskiest permissions their own line before bundling the rest', () => {
        // Four options for eight permissions means SOMETHING gets grouped. What
        // must never be grouped is the one that hands over the machine.
        const greedy = plan(
            manifest({
                permissions: {
                    scope: 'self',
                    capabilities: ['hosting', 'knowledge', 'files', 'notify', 'terminals'],
                },
            }),
        );
        const labels = greedy.questions.find((q) => q.header === 'Permissions')?.options ?? [];
        expect(labels.map((o) => o.label)).toContain('Run commands');
    });

    it('covers every requested permission across the options it offers', () => {
        // Bundling is a presentation compromise; dropping one silently would be a
        // permission the app asked for and the user was never shown.
        const wanted = ['hosting', 'knowledge', 'files', 'notify', 'terminals', 'agents'];
        const p = plan(manifest({ permissions: { scope: 'self', capabilities: wanted } }));
        const offered = new Set(Object.values(p.optionGrants).flat());
        expect([...wanted].sort()).toEqual([...offered].sort());
    });
});

describe('what the user must provide themselves', () => {
    it('gets its own visible section, not a line in a log', () => {
        const reqs = resolveAppRequirements([{ tool: 'rust', reason: 'compiles the engine' }], {
            installed: new Set<string>(),
            canInstall: () => false,
        });
        const text = plan(manifest(), reqs).questions[0]?.question ?? '';

        expect(text).toContain('rust');
        // The app's own reason travels with it — "install rust" is an instruction,
        // "install rust — it compiles the engine" is a decision.
        expect(text).toContain('compiles the engine');
    });

    it('says what Genie will install for them', () => {
        const reqs = resolveAppRequirements([{ tool: 'python', version: '3.13.15' }], {
            installed: new Set<string>(),
            canInstall: () => true,
        });
        expect(plan(manifest(), reqs).questions[0]?.question).toContain('python');
    });

    it('says nothing at all when there is nothing to say', () => {
        expect(plan().questions[0]?.question).not.toMatch(/you will need|Genie will install/i);
    });
});

describe('reading the answer', () => {
    it('installs with what the user ticked', () => {
        const p = plan();
        const label = p.questions[1]?.options[0]?.label ?? '';
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install']), answer('Permissions', [label])],
        });

        expect(outcome.install).toBe(true);
        expect(outcome.capabilities).toEqual(['hosting']);
    });

    it('installs with NOTHING when the user ticks no permission', () => {
        const p = plan();
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install']), answer('Permissions', [])],
        });

        expect(outcome.install).toBe(true);
        expect(outcome.capabilities).toEqual([]);
    });

    it('installs nothing when the user declines', () => {
        const p = plan();
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ["Don't install"])],
        });

        expect(outcome.install).toBe(false);
        expect(outcome.capabilities).toEqual([]);
    });

    it('installs nothing when the modal is dismissed', () => {
        // A dismissed modal is not a yes. It is not even a question that was asked.
        const outcome = readConsent(plan(), { cancelled: true, answers: [] });
        expect(outcome.install).toBe(false);
    });

    it('narrows to the app’s own workspace when reach was never answered', () => {
        const p = plan(
            manifest({ permissions: { scope: 'workstation', capabilities: ['hosting'] } }),
        );
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install'])],
        });

        expect(outcome.scope).toBe('self');
    });

    it('grants the wider reach only when the user chose it', () => {
        const p = plan(
            manifest({ permissions: { scope: 'workstation', capabilities: ['hosting'] } }),
        );
        const reach = p.questions.find((q) => q.header === 'Reach');
        const widest = reach?.options[reach.options.length - 1]?.label ?? '';

        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install']), answer('Reach', [widest])],
        });

        expect(outcome.scope).toBe('workstation');
    });

    it('ignores an option label it never offered', () => {
        // Defence against a replayed or tampered answer: only labels this plan
        // produced can grant anything.
        const p = plan();
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install']), answer('Permissions', ['Run commands'])],
        });

        expect(outcome.capabilities).toEqual([]);
    });

    it('never grants a capability the manifest did not declare', () => {
        // The granted set is a SUBSET of the declared set, always. Anything else
        // means the consent screen and the manifest disagree about the app.
        const p = plan();
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [
                answer('Install', ['Install']),
                answer('Permissions', p.questions[1]?.options.map((o) => o.label) ?? []),
            ],
        });

        for (const cap of outcome.capabilities) {
            expect(manifest().permissions.capabilities).toContain(cap);
        }
    });
});

/**
 * The agents the app ships, on the screen where they are agreed to.
 *
 * This is the entire reason agents are DECLARED in the manifest instead of being
 * discovered from `.agents/` (owner, 2026-08-22). A GApp's agents run under the
 * app's granted capabilities, so a file appearing in the folder would add an agent
 * nobody agreed to — and a consent screen cannot describe a set it has to go
 * looking for. Declaring them buys exactly one thing: this list. If it were not
 * shown, the cost of declaration would have bought nothing.
 */
describe('the agents a GApp ships, at install', () => {
    const withAgents = () =>
        manifest({
            agents: [
                { name: 'Strategist', persona: 'strategist.md', description: 'Designs trades.' },
                { name: 'Reviewer', persona: 'reviewer.md' },
            ],
        });

    it('names every agent the app will run', () => {
        const text = plan(withAgents()).questions[0]?.question ?? '';

        expect(text).toContain('Strategist');
        expect(text).toContain('Reviewer');
    });

    it('shows what an agent is FOR when the app said', () => {
        const text = plan(withAgents()).questions[0]?.question ?? '';
        expect(text).toContain('Designs trades.');
    });

    it('says the agents run on the permissions being granted here', () => {
        // The sentence that makes the list mean something. Without it the roster
        // reads as trivia; with it, ticking a permission is visibly ticking it for
        // these agents too.
        const text = plan(withAgents()).questions[0]?.question ?? '';
        expect(text).toMatch(/permissions you grant/i);
    });

    it('says nothing at all about agents when the app ships none', () => {
        // Most GApps ship none. A heading over an empty list is noise on the one
        // screen that must stay readable.
        const text = plan().questions[0]?.question ?? '';
        expect(text.toLowerCase()).not.toContain('agent');
    });

    it('names them on the PREVIEW screen too', () => {
        // A preview's grant is a REAL grant — `previewGrant` narrows the declared
        // set exactly as the install path does — so its agents really do run on the
        // permissions ticked below. Showing the roster at install and hiding it at
        // preview would put the one screen a developer is guaranteed to read on the
        // wrong side of the thing declaration exists to buy.
        const text =
            buildConsentPlan(
                manifest({ agents: [{ name: 'Strategist', persona: 'strategist.md' }] }),
                noRequirements,
                { preview: true },
            ).questions[0]?.question ?? '';

        expect(text).toContain('Strategist');
        expect(text).toMatch(/permissions you grant/i);
    });
});

describe('the PREVIEW framing', () => {
    const previewable = () =>
        manifest({
            permissions: { scope: 'workstation', capabilities: ['terminals', 'hosting'] },
        });

    it('asks the same permission and reach questions, word for word', () => {
        // The reason a preview shows a consent screen AT ALL is that a developer
        // who never sees their own consent screen never learns what it says. That
        // only holds while it is the SAME screen — so everything below the first
        // question is the install plan's, unchanged, and this test is what keeps
        // it that way when either is edited.
        const install = buildConsentPlan(previewable(), noRequirements);
        const preview = buildConsentPlan(previewable(), noRequirements, { preview: true });

        expect(preview.questions.slice(1)).toEqual(install.questions.slice(1));
        expect(preview.optionGrants).toEqual(install.optionGrants);
        expect(preview.scopeChoices).toEqual(install.scopeChoices);
    });

    it('does not offer to install something', () => {
        const plan = buildConsentPlan(previewable(), noRequirements, { preview: true });

        expect(plan.installLabel).toBe('Preview');
        expect(plan.questions[0]!.header).toBe('Preview');
        expect(plan.questions[0]!.question).toContain('Preview');
        // The developer is about to be shown a permission screen. If they read it
        // as an install prompt they will hesitate over the wrong decision — and if
        // they read it as free they will not read it at all.
        expect(plan.questions[0]!.question).toMatch(/not installed|nothing is installed/i);
    });

    it('names the preview address, never the app’s real one', () => {
        // `whatItSetsUp` tells the user which site appears. For a preview it has to
        // be the preview's own address: telling a developer that `trader.gen` is
        // about to be served would describe a takeover of their installed copy that
        // is precisely what previewing refuses to do.
        const plan = buildConsentPlan(
            { ...previewable(), slug: 'trader.preview' },
            noRequirements,
            { preview: true },
        );

        expect(plan.questions[0]!.question).toContain('trader.preview.gen');
    });

    it('reads a yes exactly as the install plan does', () => {
        const plan = buildConsentPlan(previewable(), noRequirements, { preview: true });

        const outcome = readConsent(plan, {
            cancelled: false,
            answers: [
                { header: 'Preview', question: '', selected: ['Preview'], note: '' },
                {
                    header: 'Permissions',
                    question: '',
                    selected: Object.keys(plan.optionGrants),
                    note: '',
                },
            ],
        });

        expect(outcome.install).toBe(true);
        expect(outcome.capabilities.sort()).toEqual(['hosting', 'terminals']);
    });

    it('creates nothing when the modal is dismissed', () => {
        const plan = buildConsentPlan(previewable(), noRequirements, { preview: true });
        expect(readConsent(plan, { cancelled: true, answers: [] }).install).toBe(false);
    });
});

/**
 * An app that LENDS CAPABILITY OUTWARD — the consent half of the capability
 * provider.
 *
 * "Agents in any workspace will be able to make this app render video" is spending
 * the user's CPU, disk and time at somebody else's request. That is a grant, so it
 * gets a DECISION on this screen rather than a sentence: the user can narrow it
 * exactly as they can narrow reach.
 *
 * And it is a SEPARATE decision from reach, deliberately. `scope` is what the app
 * may touch; `consumers` is who may spend it. Folding them into one question would
 * put the two grants behind one answer, and one of them would be wrong.
 */
describe('an app that offers its tools to other agents', () => {
    const provider = (consumers?: unknown) =>
        manifest({
            slug: 'remotion',
            name: 'Remotion',
            services: [{ name: 'renderer', command: ['node', 'server.js'] }],
            contributes: {
                mcpTools: [
                    { name: 'renderVideo', description: 'Render a composition.', inputSchema: { type: 'object' } },
                ],
                servedBy: 'renderer',
                transport: { kind: 'stdio' },
            },
            permissions: {
                scope: 'self',
                capabilities: ['hosting'],
                ...(consumers ? { consumers } : {}),
            },
        });

    it('says on the install screen that the app offers tools', () => {
        const text = buildConsentPlan(provider({ scope: 'workstation' }), noRequirements)
            .questions[0]?.question ?? '';
        expect(text).toMatch(/renderVideo|1 tool/i);
    });

    it('asks WHOSE agents may call them, as its own decision', () => {
        const p = buildConsentPlan(provider({ scope: 'workstation' }), noRequirements);
        const tools = p.questions.find((q) => q.header === 'Tools');

        expect(tools, 'a workstation-wide offer must be put to the user').toBeTruthy();
        expect(tools?.options.length).toBeGreaterThanOrEqual(2);
    });

    it('asks nothing when the app keeps its tools to itself', () => {
        const p = buildConsentPlan(provider(), noRequirements);
        expect(p.questions.some((q) => q.header === 'Tools')).toBe(false);
    });

    it('is a decision SEPARATE from reach — an app can be `self` and still lend out', () => {
        // The distinction the whole field exists for. Remotion touches nothing but
        // its own workspace, and is callable from everywhere.
        const p = buildConsentPlan(provider({ scope: 'workstation' }), noRequirements);
        expect(p.questions.some((q) => q.header === 'Reach')).toBe(false);
        expect(p.questions.some((q) => q.header === 'Tools')).toBe(true);
    });

    it('narrows to the app itself when the offer question went unanswered', () => {
        const p = buildConsentPlan(provider({ scope: 'workstation' }), noRequirements);
        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install'])],
        });

        expect(outcome.consumers).toEqual({ scope: 'self' });
    });

    it('grants the wide offer only when the user picked it', () => {
        const p = buildConsentPlan(provider({ scope: 'workstation' }), noRequirements);
        const tools = p.questions.find((q) => q.header === 'Tools');
        const widest = tools?.options[tools.options.length - 1]?.label ?? '';

        const outcome = readConsent(p, {
            cancelled: false,
            answers: [answer('Install', ['Install']), answer('Tools', [widest])],
        });

        expect(outcome.consumers).toEqual({ scope: 'workstation' });
    });

    it('stays inside the modal’s four questions with everything asked at once', () => {
        // Install + Permissions + Reach + Tools is exactly four. This is the test
        // that fails if a fifth question is ever added without bundling.
        const p = buildConsentPlan(
            manifest({
                slug: 'remotion',
                name: 'Remotion',
                services: [{ name: 'renderer', command: ['node', 'server.js'] }],
                contributes: {
                    mcpTools: [
                        { name: 'renderVideo', description: 'd', inputSchema: { type: 'object' } },
                    ],
                    servedBy: 'renderer',
                    transport: { kind: 'stdio' },
                },
                permissions: {
                    scope: 'workstation',
                    capabilities: ['terminals', 'agents', 'hosting', 'files', 'notify'],
                    consumers: { scope: 'workstation' },
                },
            }),
            noRequirements,
        );

        expect(p.questions.map((q) => q.header)).toEqual([
            'Install',
            'Permissions',
            'Reach',
            'Tools',
        ]);
        for (const q of p.questions) {
            expect(q.options.length, q.header).toBeLessThanOrEqual(4);
        }
    });
});
