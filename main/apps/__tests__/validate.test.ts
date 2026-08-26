import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateAppFolder, type FolderProbe } from '../validate';

/**
 * Checking a Genie App WITHOUT installing it (Tynn #250, P2).
 *
 * This is the loop a developer — or the agent writing the app — actually works
 * in: change something, ask if it is right, fix what it says. Without it the only
 * feedback is an install that either refuses with schema errors or "succeeds" and
 * then serves a blank page, which teaches nothing about which of the two happened.
 *
 * So it checks the things the manifest validator structurally CANNOT: whether what
 * the manifest points at is actually there. A manifest can be perfectly valid and
 * describe an app that cannot work.
 *
 * Errors and advice are separate lists on purpose. An error means it will not run;
 * advice means it will run and the developer should think about it. Merging them
 * trains people to ignore both.
 */

const manifest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: ['hosting'] },
        ...over,
    });

const probe = (over: Partial<FolderProbe> = {}): FolderProbe => ({
    readManifest: () => manifest(),
    exists: () => true,
    slugTaken: () => false,
    ...over,
});

describe('a folder that is ready to install', () => {
    it('passes, with nothing to say', () => {
        const report = validateAppFolder('C:/src/trader', probe());

        expect(report.ok).toBe(true);
        expect(report.errors).toEqual([]);
    });

    it('reports back what the app IS, so a UI can show it before installing', () => {
        const report = validateAppFolder('C:/src/trader', probe());

        expect(report.app).toMatchObject({ name: 'Example Trader', slug: 'trader' });
    });
});

describe('what the manifest validator cannot see', () => {
    it('catches a front end pointed at a directory that is not there', () => {
        // The failure this prevents: install succeeds, the site starts, and
        // `trader.gen` serves a 404 the user reads as a broken app.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ exists: (p) => !p.endsWith('dist') }),
        );

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('dist');
    });

    it('catches a service whose repo folder is missing', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({
                        services: [{ name: 'api', repo: 'backend', command: ['node', 'server.mjs'] }],
                    }),
                exists: (p) => !p.endsWith('backend'),
            }),
        );

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('backend');
    });

    it('does not demand a directory for a PROXY front end', () => {
        // A proxy app has no built output — its front end is a dev server the
        // developer runs. Insisting on a folder would fail every Ripple-shaped app.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({ frontend: { serve: { mode: 'proxy', hostPort: 5273 } } }),
                exists: () => false,
            }),
        );

        expect(report.ok).toBe(true);
    });

    it('does NOT flag an app re-checking itself', () => {
        // The probe is told who is asking. Without that, every reinstall would
        // report its own address as taken.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ slugTaken: (_slug, selfId) => selfId !== 'com.example.trader' }),
        );
        expect(report.ok).toBe(true);
    });

    it('catches a slug another installed app already owns', () => {
        // Two apps at `trader.gen` is one app the user cannot reach, and the
        // failure would appear at HOSTING time, far from the cause.
        const report = validateAppFolder('C:/src/trader', probe({ slugTaken: () => true }));

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('trader.gen');
    });
});

describe('the manifest itself', () => {
    it('passes schema errors straight through', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ readManifest: () => manifest({ slug: 'Not A Slug' }) }),
        );

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('slug');
    });

    it('says plainly when the folder is not a Genie App at all', () => {
        const report = validateAppFolder('C:/src/nothing', probe({ readManifest: () => null }));

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('genie-app.json');
    });

    it('does not crash on a file that is not JSON', () => {
        const report = validateAppFolder('C:/src/trader', probe({ readManifest: () => '{{{' }));
        expect(report.ok).toBe(false);
    });
});

/**
 * A converted `.agi` envelope — a GApp Development Workspace (genie#268).
 *
 * The other fixtures in this file are SCAFFOLDED staging folders, which are flat
 * by construction, so none of them can reach the envelope branch. That is exactly
 * why the layout bug survived: the only way to hit it is a folder that was already
 * an envelope before it was a GApp, and converting a real workspace is what a GDW
 * IS. A flat fixture would pass here forever with the bug live.
 *
 * Modelled on the reproduction (`the-ripple-effect.agi`): manifest at the envelope
 * root, `frontend.repo` naming a component that sits at `repos/<name>`, and
 * NOTHING flat beside the manifest.
 */
const ENVELOPE = 'C:/src/the-ripple-effect.agi';

const envelopeManifest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        id: 'com.civicognita.ripple',
        slug: 'ripple',
        name: 'The Ripple Effect',
        version: '0.1.0',
        frontend: { repo: 'the-ripple-effect', serve: { mode: 'proxy', hostPort: 5273 } },
        permissions: { scope: 'self', capabilities: [] },
        ...over,
    });

/**
 * The envelope's filesystem, as an explicit set.
 *
 * A set rather than a `endsWith` negation, because the assertion that matters is
 * that nothing sits FLAT — and a predicate that answers "true unless it ends in
 * X" quietly invents a flat component alongside the real one.
 */
const envelopeFs = (...extra: string[]) =>
    new Set([
        path.join(ENVELOPE, 'project.json'),
        path.join(ENVELOPE, '.gitmodules'),
        path.join(ENVELOPE, 'repos'),
        path.join(ENVELOPE, 'repos', 'the-ripple-effect'),
        ...extra,
    ]);

describe('a converted .agi envelope, where the components already live at repos/', () => {
    it('finds the component where an envelope actually keeps it', () => {
        const present = envelopeFs();
        const report = validateAppFolder(
            ENVELOPE,
            probe({
                readManifest: () => envelopeManifest(),
                exists: (p) => present.has(p),
            }),
        );

        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);

        // POSITIVE CONTROL. The assertion above is an ABSENCE, and an absence also
        // holds when the check never ran at all — so prove the same fixture still
        // catches the real thing. Delete the component from `repos/` and the
        // envelope must fail; if this half passes too, the check is alive and the
        // half above means what it says.
        const gone = envelopeFs();
        gone.delete(path.join(ENVELOPE, 'repos', 'the-ripple-effect'));
        const missing = validateAppFolder(
            ENVELOPE,
            probe({ readManifest: () => envelopeManifest(), exists: (p) => gone.has(p) }),
        );

        expect(missing.ok).toBe(false);
        expect(missing.errors.join(' ')).toContain('the-ripple-effect');
    });

    it('tells a developer the place their own layout keeps it', () => {
        // The fix text is the whole value of the check. Told "it names a folder
        // beside the manifest", a developer standing in an envelope goes looking
        // for a duplicate of a folder they are already looking at.
        const gone = envelopeFs();
        gone.delete(path.join(ENVELOPE, 'repos', 'the-ripple-effect'));
        const report = validateAppFolder(
            ENVELOPE,
            probe({ readManifest: () => envelopeManifest(), exists: (p) => gone.has(p) }),
        );

        const fix = report.findings.map((f) => f.fix).join(' ');
        expect(fix).toContain('repos/the-ripple-effect');
        expect(fix).not.toContain('beside the manifest');
    });

    it('resolves a service the same way, not just the front end', () => {
        const present = envelopeFs(path.join(ENVELOPE, 'repos', 'api'));
        const report = validateAppFolder(
            ENVELOPE,
            probe({
                readManifest: () =>
                    envelopeManifest({
                        services: [{ name: 'api', repo: 'api', command: ['node', 'server.mjs'] }],
                    }),
                exists: (p) => present.has(p),
            }),
        );

        expect(report.errors).toEqual([]);

        // POSITIVE CONTROL: the service check still bites in this layout.
        const gone = envelopeFs();
        const missing = validateAppFolder(
            ENVELOPE,
            probe({
                readManifest: () =>
                    envelopeManifest({
                        services: [{ name: 'api', repo: 'api', command: ['node', 'server.mjs'] }],
                    }),
                exists: (p) => gone.has(p),
            }),
        );
        expect(missing.ok).toBe(false);
        expect(missing.errors.join(' ')).toContain('api');
    });

    it('looks for a static front end under the component, not beside the manifest', () => {
        const present = envelopeFs(
            path.join(ENVELOPE, 'repos', 'the-ripple-effect', 'dist'),
        );
        const report = validateAppFolder(
            ENVELOPE,
            probe({
                readManifest: () =>
                    envelopeManifest({
                        frontend: {
                            repo: 'the-ripple-effect',
                            serve: { mode: 'static', root: 'dist' },
                        },
                    }),
                exists: (p) => present.has(p),
            }),
        );

        expect(report.errors).toEqual([]);

        // POSITIVE CONTROL: an unbuilt front end is still caught here.
        const unbuilt = envelopeFs();
        const missing = validateAppFolder(
            ENVELOPE,
            probe({
                readManifest: () =>
                    envelopeManifest({
                        frontend: {
                            repo: 'the-ripple-effect',
                            serve: { mode: 'static', root: 'dist' },
                        },
                    }),
                exists: (p) => unbuilt.has(p),
            }),
        );
        expect(missing.ok).toBe(false);
        expect(missing.errors.join(' ')).toContain('dist');
    });
});

describe('a scaffolded staging folder still resolves flat', () => {
    // The other layout, asserted explicitly so fixing the envelope one cannot
    // quietly move every app to `repos/` and break the folder `scaffoldApp` writes.
    const STAGING = 'C:/src/trader';
    const stagingFs = (...extra: string[]) =>
        new Set([path.join(STAGING, 'web'), path.join(STAGING, 'web', 'dist'), ...extra]);

    it('finds a flat component beside the manifest, with no project.json in sight', () => {
        const present = stagingFs();
        const report = validateAppFolder(
            STAGING,
            probe({ exists: (p) => present.has(p) }),
        );

        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);

        // POSITIVE CONTROL: the flat check still bites.
        const gone = stagingFs();
        gone.delete(path.join(STAGING, 'web'));
        gone.delete(path.join(STAGING, 'web', 'dist'));
        const missing = validateAppFolder(STAGING, probe({ exists: (p) => gone.has(p) }));

        expect(missing.ok).toBe(false);
        expect(missing.errors.join(' ')).toContain('web');
    });

    it('still tells a staging developer the folder goes beside the manifest', () => {
        const gone = stagingFs();
        gone.delete(path.join(STAGING, 'web'));
        gone.delete(path.join(STAGING, 'web', 'dist'));
        const report = validateAppFolder(STAGING, probe({ exists: (p) => gone.has(p) }));

        expect(report.findings.map((f) => f.fix).join(' ')).toContain('beside the manifest');
    });
});

describe('advice — it will run, but think about it', () => {
    it('flags asking for the whole workstation', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({ permissions: { scope: 'workstation', capabilities: ['hosting'] } }),
            }),
        );

        // Still installable — it is the user's call, not the linter's.
        expect(report.ok).toBe(true);
        expect(report.advice.join(' ')).toMatch(/workstation/i);
    });

    it('flags every high-risk capability by name', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({
                        permissions: { scope: 'self', capabilities: ['terminals', 'secrets'] },
                    }),
            }),
        );

        expect(report.advice.join(' ')).toContain('Run commands');
        expect(report.advice.join(' ')).toContain('Environment variables and secrets');
    });

    it('flags a requirement with no reason, since the user has to act on it', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ readManifest: () => manifest({ requires: [{ tool: 'docker' }] }) }),
        );

        expect(report.advice.join(' ')).toContain('docker');
        expect(report.advice.join(' ')).toMatch(/reason/i);
    });

    it('flags asking to be reachable from the real browser', () => {
        // It costs a one-time admin prompt on the user's machine. Worth being sure.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({
                        frontend: {
                            repo: 'web',
                            serve: { mode: 'static', root: 'dist' },
                            browserExposed: true,
                        },
                    }),
            }),
        );

        expect(report.advice.join(' ')).toMatch(/browser/i);
    });

    it('stays quiet about a modest app', () => {
        expect(validateAppFolder('C:/src/trader', probe()).advice).toEqual([]);
    });
});

/**
 * The consequence that makes DECLARING agents worth its cost (owner, 2026-08-22).
 *
 * Agents are declared in the manifest rather than discovered from `.agents/`,
 * because a GApp's agents run under the app's granted capabilities and a consent
 * screen cannot describe a set it has to go looking for. The accepted cost is two
 * places to keep in step — and this is what stops them drifting silently.
 *
 * A declared agent with no persona file behind it is the same class of failure as
 * a front end pointed at a `dist` nobody built: the manifest is valid, the install
 * succeeds, and the thing it promised is not there.
 */
describe('the agents a GApp declared, against the folder it shipped', () => {
    const withAgents = () =>
        manifest({
            agents: [
                { name: 'Strategist', persona: 'strategist.md' },
                { name: 'Reviewer', persona: 'reviewer/persona.md' },
            ],
        });

    it('passes when every declared persona is there', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ readManifest: () => withAgents() }),
        );

        expect(report.ok).toBe(true);
        expect(report.errors).toEqual([]);
    });

    it('FAILS when a declared agent has no persona file', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () => withAgents(),
                exists: (p) => !p.includes('reviewer'),
            }),
        );

        expect(report.ok).toBe(false);
        // Named, so the developer knows which of the two to fix.
        expect(report.errors.join(' ')).toContain('Reviewer');
        expect(report.errors.join(' ')).toContain('persona');
    });

    it('reports EVERY missing persona, not just the first', () => {
        // Same rule the manifest validator follows: fixing one problem at a time
        // wastes the developer's day.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ readManifest: () => withAgents(), exists: (p) => !p.includes('.agents') }),
        );

        expect(report.errors.filter((e) => e.includes('persona'))).toHaveLength(2);
    });

    it('looks for personas under `.agents/` in the ENVELOPE, not inside a repo', () => {
        // `.agents/` is envelope-owned, beside `repos/` and `project.json` — an
        // agent belongs to the APP, not to any one of its repos.
        const looked: string[] = [];
        validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () => withAgents(),
                exists: (p) => {
                    looked.push(p.split(path.sep).join('/'));
                    return true;
                },
            }),
        );

        expect(looked).toContain('C:/src/trader/.agents/strategist.md');
    });

    it('says nothing about agents when the app ships none', () => {
        const report = validateAppFolder('C:/src/trader', probe());
        expect(report.errors.join(' ')).not.toContain('persona');
    });
});

/**
 * Every answer is a STRUCTURED finding (genie#245 follow-on).
 *
 * `errors: string[]` was enough while the only reader was a paragraph in a
 * settings panel. It is not enough for a suite a developer runs against their own
 * app: a bare sentence cannot be grouped, filtered, pointed at a file, or asserted
 * on by id, and — the part that actually matters — nothing forced it to say what to
 * DO. The string lists are now DERIVED from the findings, so there is one message
 * per rule and every caller that joins them keeps working.
 */
describe('findings — what is wrong, where, and what to do', () => {
    it('answers all three questions for every finding it emits', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({
                        permissions: { scope: 'workstation', capabilities: ['terminals'] },
                        requires: [{ tool: 'docker' }],
                    }),
                exists: () => false,
            }),
        );

        expect(report.findings.length).toBeGreaterThan(0);
        for (const finding of report.findings) {
            expect(finding.check, 'check id').toBeTruthy();
            expect(finding.where, `where for ${finding.check}`).toBeTruthy();
            expect(finding.problem, `problem for ${finding.check}`).toBeTruthy();
            // The half that was never enforced before, and the whole reason the
            // shape changed: a diagnosis with no instruction is half a sentence.
            expect(finding.fix, `fix for ${finding.check}`).toBeTruthy();
        }
    });

    it('points a missing persona at the FILE, not at the manifest', () => {
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({ agents: [{ name: 'Reviewer', persona: 'reviewer.md' }] }),
                exists: (p) => !p.includes('.agents'),
            }),
        );

        const finding = report.findings.find((f) => f.check === 'agents.persona-missing');
        expect(finding?.where.split(path.sep).join('/')).toBe('C:/src/trader/.agents/reviewer.md');
        expect(finding?.severity).toBe('error');
    });

    it('keeps the legacy string lists as a VIEW of the findings', () => {
        // Every existing caller — the installer, the previewer, the GitHub review,
        // the settings panel — reads these. They must not drift from the findings
        // they are made of, so they are computed, never written twice.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({
                readManifest: () =>
                    manifest({ permissions: { scope: 'workstation', capabilities: ['terminals'] } }),
                exists: () => false,
            }),
        );

        expect(report.errors).toHaveLength(
            report.findings.filter((f) => f.severity === 'error').length,
        );
        expect(report.advice).toHaveLength(
            report.findings.filter((f) => f.severity === 'advice').length,
        );
        // And the derived line SAYS what to do, rather than only what is wrong.
        const persona = report.findings.find((f) => f.severity === 'error');
        expect(report.errors.join(' ')).toContain(persona!.fix);
    });

    it('names the folder a component is missing from, instead of blaming the build', () => {
        // "web/dist does not exist — build it first" is the wrong instruction when
        // `web` itself is not there: no build produces a folder the manifest named
        // and the developer never created.
        const report = validateAppFolder(
            'C:/src/trader',
            probe({ exists: (p) => !p.endsWith('web') && !p.includes('web') }),
        );

        const finding = report.findings.find((f) => f.check === 'frontend.repo-missing');
        expect(finding, 'a missing component folder is its own finding').toBeDefined();
        expect(finding?.problem).toContain('web');
        // And the root check does NOT also fire — one cause, one finding.
        expect(report.findings.filter((f) => f.check === 'frontend.root-missing')).toEqual([]);
    });
});
