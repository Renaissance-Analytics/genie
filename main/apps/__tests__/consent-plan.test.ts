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
