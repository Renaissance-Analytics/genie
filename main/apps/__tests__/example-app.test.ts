import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateAppManifest, APP_MANIFEST_FILENAME } from '../manifest';
import { appInstallPlan } from '../install-plan';
import { checkApp } from '../checkup';
import { fsCheckProbe } from '../check-fs';
import { formatCheckReport } from '../findings';

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

    it('ships an AGENT, which is the newest half of the manifest', () => {
        // `.agents/` is the part with no prior art to copy, so the example is where
        // it gets demonstrated. That the persona is actually THERE is the suite's
        // job below — this is the claim that the example demonstrates the feature
        // at all.
        expect(manifest().agents?.length).toBeGreaterThan(0);
    });

    it('DEMONSTRATES the real runtime surface', () => {
        // The example uses `window.genieApp` directly rather than the SDK, on
        // purpose: it is the proof of what the surface IS. That it never reaches
        // for the `window.genie` that does not exist is checked generically by the
        // suite, over the whole served directory rather than this one file.
        const source = fs.readFileSync(path.join(EXAMPLE_DIR, 'web', 'app.js'), 'utf8');
        expect(source).toContain('genieApp');
    });

    it('passes the WHOLE check suite, with nothing at all to say', () => {
        // The example is documentation people copy, and the suite is what Genie
        // tells them to run against their copy. An example that tripped it would
        // teach that the system is broken rather than the example — so this is the
        // one test that has to hold no matter which check gets added next.
        //
        // It also makes the example a live consumer: every generic rule (files
        // where the manifest points, personas on disk, a roster the window can
        // run, a front end that reaches for an API that exists) is asserted here
        // through the same code path a developer runs, instead of being restated
        // by hand and drifting.
        const report = checkApp(EXAMPLE_DIR, fsCheckProbe({ slugTaken: () => false }));

        expect(report.findings, formatCheckReport(report, EXAMPLE_DIR)).toEqual([]);
    });

    it('installs into an ordinary Genie site', () => {
        const plan = appInstallPlan('ws-example', manifest());

        expect(plan.site.genName).toBe('example.gen');
        expect(plan.site.runMode).toBe('host');
        expect(plan.processes).toHaveLength(1);
        expect(plan.processes[0]?.cwd).toBe('repos/service');
    });
});
