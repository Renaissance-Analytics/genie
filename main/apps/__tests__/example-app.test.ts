import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateAppManifest, APP_AGENTS_DIR, APP_MANIFEST_FILENAME } from '../manifest';
import { validateAppFolder } from '../validate';
import { appInstallPlan } from '../install-plan';

/**
 * The reference GApp, checked against the real validator (Tynn #250).
 *
 * `apps/example/` is documentation people will copy, and documentation that does
 * not parse is worse than none — a developer who starts from a manifest the
 * installer rejects concludes the SYSTEM is broken, not the example.
 *
 * It is also the only test that reads a manifest off disk rather than from a
 * literal, so it catches the class of mistake the unit tests structurally cannot:
 * a schema change that everyone's hand-written fixtures were updated for and the
 * shipped example was not.
 */

const EXAMPLE_DIR = path.join(__dirname, '..', '..', '..', 'apps', 'example');

const manifest = () => {
    const raw = fs.readFileSync(path.join(EXAMPLE_DIR, APP_MANIFEST_FILENAME), 'utf8');
    const result = validateAppManifest(JSON.parse(raw));
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

describe('the shipped example app', () => {
    it('is a valid manifest', () => {
        expect(() => manifest()).not.toThrow();
    });

    it('is MULTI-COMPONENT, which is the thing it exists to demonstrate', () => {
        // A front end alone would be an example of the easy case, and would leave
        // the shape the real apps actually have — a service in another process —
        // undemonstrated and therefore untested.
        const m = manifest();
        expect(m.frontend).toBeDefined();
        expect(m.services?.length).toBeGreaterThan(0);
        expect(m.services?.[0]?.command).toEqual(expect.arrayContaining(['node']));
    });

    it('asks for the LEAST it can, since developers copy the permissions block', () => {
        const m = manifest();
        expect(m.permissions.scope).toBe('self');
        // Nothing high-risk. An example that casually requested terminals would
        // teach every app built from it to request terminals.
        for (const forbidden of ['terminals', 'agents', 'processes', 'secrets', 'ask']) {
            expect(m.permissions.capabilities).not.toContain(forbidden);
        }
    });

    it('gives a reason for every runtime it needs', () => {
        for (const requirement of manifest().requires ?? []) {
            expect(requirement.reason, requirement.tool).toBeTruthy();
        }
    });

    it('every file the manifest points at is actually there', () => {
        // The failure this catches is a rename: the manifest still validates, the
        // install still succeeds, and the site serves a 404 the user reads as a
        // broken product.
        const m = manifest();
        const frontendRoot = path.join(EXAMPLE_DIR, m.frontend.repo ?? '');
        expect(fs.existsSync(frontendRoot), frontendRoot).toBe(true);
        expect(fs.existsSync(path.join(frontendRoot, 'index.html'))).toBe(true);

        for (const service of m.services ?? []) {
            const entry = path.join(EXAMPLE_DIR, service.repo ?? '', service.command[1] ?? '');
            expect(fs.existsSync(entry), entry).toBe(true);
        }
    });

    it('ships an AGENT, declared in the manifest with its persona on disk', () => {
        // `.agents/` is the newest half of the manifest and the one with no prior
        // art to copy, so the example is where it gets demonstrated. It also gives
        // the folder check a real directory to be right about: declaration and
        // folder drifting apart is the failure declaring agents exists to catch,
        // and every other test for it uses a probe.
        const m = manifest();
        expect(m.agents?.length).toBeGreaterThan(0);
        for (const agent of m.agents ?? []) {
            const persona = path.join(EXAMPLE_DIR, APP_AGENTS_DIR, agent.persona);
            expect(fs.existsSync(persona), persona).toBe(true);
        }
    });

    it('passes the folder check Genie runs before installing it', () => {
        // The example is documentation people copy. An example that would be
        // REFUSED at install teaches that the system is broken, not the example.
        const report = validateAppFolder(EXAMPLE_DIR, {
            readManifest: (folder) =>
                fs.readFileSync(path.join(folder, APP_MANIFEST_FILENAME), 'utf8'),
            exists: (p) => fs.existsSync(p),
            slugTaken: () => false,
        });

        expect(report.errors).toEqual([]);
    });

    it('never reaches for window.genie', () => {
        // The isolation claim, asserted against the shipped code rather than
        // trusted: a GApp's window has no `window.genie`, and an example that
        // reached for it would be teaching an API that does not exist.
        const source = fs.readFileSync(path.join(EXAMPLE_DIR, 'web', 'app.js'), 'utf8');
        // Comments stripped first: the example NAMES `window.genie` when explaining
        // that it does not exist, and a test that counted that as usage would be
        // asserting something other than what it says.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/\bwindow\.genie\b(?!App)/);
        expect(code).toContain('genieApp');
    });

    it('installs into an ordinary Genie site', () => {
        const plan = appInstallPlan('ws-example', manifest());

        expect(plan.site.genName).toBe('example.gen');
        expect(plan.site.runMode).toBe('host');
        expect(plan.processes).toHaveLength(1);
        expect(plan.processes[0]?.cwd).toBe('repos/service');
    });
});
