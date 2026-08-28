import { describe, expect, it } from 'vitest';
import { checkApp, type CheckProbe } from '../checkup';
import type { AppFinding } from '../findings';

/**
 * The GApp testing suite — what a developer runs against their OWN app before
 * anybody installs it (genie#245 follow-on).
 *
 * The failure it exists to prevent is the one genie#245 fixed: a developer followed
 * the SDK README, shipped personas, installed, and got empty terminals with NO
 * ERROR. Nothing told them anything was wrong. This is what should have told them.
 *
 * So every test here asserts on the MESSAGE, not merely on the failure. A checker
 * that fails for the right reason and says `expected true, got false` has done the
 * easy half and none of the useful half — the developer is back where they started,
 * looking at something that does not work and being told nothing they can act on.
 */

const FOLDER = 'C:/src/trader';

/** A minimal manifest that PASSES, so each test can break exactly one thing. */
const app = (over: Record<string, unknown> = {}) => ({
    id: 'com.example.trader',
    slug: 'trader',
    name: 'Trader',
    version: '1.0.0',
    frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
    permissions: { scope: 'self', capabilities: ['hosting'] },
    ...over,
});

/** The files that make the manifest above true. */
const TREE: Record<string, string> = {
    'gapp.json': '',
    'web/dist/index.html': '<!doctype html><html><body><script src="app.js"></script></body></html>',
    'web/dist/app.js': 'const genie = window.genieApp;\n',
};

const norm = (p: string) => p.split(/[\\/]/).join('/').replace(/\/+$/, '');

function probeFor(
    manifest: unknown,
    tree: Record<string, string> = TREE,
    over: Partial<CheckProbe> = {},
): CheckProbe {
    const paths = Object.keys(tree).map((p) => `${FOLDER}/${p}`);
    return {
        readManifest: () => (manifest === null ? null : JSON.stringify(manifest)),
        exists: (p) => {
            const a = norm(p);
            return a === FOLDER || paths.includes(a) || paths.some((f) => f.startsWith(`${a}/`));
        },
        slugTaken: () => false,
        listFiles: (dir) => paths.filter((f) => f.startsWith(`${norm(dir)}/`)),
        readText: (p) => tree[norm(p).slice(FOLDER.length + 1)] ?? null,
        ...over,
    };
}

const check = (manifest: unknown, tree?: Record<string, string>, over?: Partial<CheckProbe>) =>
    checkApp(FOLDER, probeFor(manifest, tree, over));

const find = (findings: AppFinding[], id: string): AppFinding | undefined =>
    findings.find((f) => f.check === id);

/** Assert a check fired AND that what it says is worth reading. */
function expectFinding(findings: AppFinding[], id: string): AppFinding {
    const finding = find(findings, id);
    expect(
        finding,
        `expected the check "${id}" to fire; got: ${findings.map((f) => f.check).join(', ') || '(nothing)'}`,
    ).toBeDefined();
    return finding!;
}

describe('an app with nothing wrong with it', () => {
    it('passes, and says how much it looked at', () => {
        const report = check(app());

        expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
        expect(report.ok).toBe(true);
        // "No errors" from a suite that silently skipped everything is the same
        // false reassurance this module exists to remove, so a clean report has to
        // NAME what it covered.
        expect(report.ran).toContain('install-gate');
        expect(report.ran).toContain('frontend.no-index');
        expect(report.ran).toContain('frontend.window-genie');
    });

    it('reports what the app IS, so a UI can show it before installing', () => {
        expect(check(app()).app).toMatchObject({ name: 'Trader', slug: 'trader' });
    });
});

describe('it runs the REAL install gate, never a second copy of it', () => {
    it('surfaces what `validateAppFolder` finds', () => {
        // A checker with its own copy of a rule disagrees with the installer the
        // moment either changes, and then it lies — worse than not existing.
        const report = check(app({ agents: [{ name: 'Reviewer', persona: 'reviewer.md' }] }));

        const finding = expectFinding(report.findings, 'agents.persona-missing');
        expect(finding.problem).toContain('Reviewer');
        expect(finding.where).toContain('.agents');
    });

    it('stops at the schema, because nothing below it can be trusted', () => {
        const report = check(app({ slug: 'Not A Slug' }));

        expect(expectFinding(report.findings, 'manifest.schema').problem).toContain('slug');
    });
});

/**
 * The front end — the half a user SEES, and the half that fails silently.
 */
describe('the front end a user will actually look at', () => {
    it('catches a served directory with no index.html', () => {
        // The purest form of the failure this suite exists for: it installs, the
        // site starts, the window opens on nothing at all.
        const report = check(app(), {
            'gapp.json': '',
            'web/dist/bundle.js': '',
        });

        const finding = expectFinding(report.findings, 'frontend.no-index');
        expect(finding.severity).toBe('error');
        expect(finding.where).toMatch(/index\.html$/);
        // It has to say what the user will SEE, or a developer reads it as pedantry.
        expect(finding.problem).toMatch(/empty|blank|nothing/i);
        expect(finding.fix).toContain('frontend.serve.root');
    });

    it('catches a front end reaching for `window.genie`, which does not exist', () => {
        const report = check(app(), {
            ...TREE,
            'web/dist/app.js': 'const g = window.genie;\ng.call("manageSite", {});\n',
        });

        const finding = expectFinding(report.findings, 'frontend.window-genie');
        expect(finding.severity).toBe('error');
        // WHICH file — a bare "your app uses window.genie" in a dist of 40 files is
        // a search, not a fix.
        expect(finding.where).toContain('app.js');
        // And the thing to use INSTEAD, named.
        expect(finding.fix).toContain('genieApp');
    });

    it('does not mistake a COMMENT about `window.genie` for a use of it', () => {
        // The shipped example names it while explaining that it does not exist. A
        // check that counted that would be asserting something other than it says —
        // and a false positive on the reference app teaches people to ignore the
        // whole suite.
        const report = check(app(), {
            ...TREE,
            'web/dist/app.js':
                '/* No `window.genie` here. */\n// window.genie is not a thing\nconst g = globalThis.genieApp;\n',
        });

        expect(find(report.findings, 'frontend.window-genie')).toBeUndefined();
    });

    it('treats an UNTERMINATED comment as a comment, the way a browser does', () => {
        // Caught by CodeQL as `js/incomplete-multi-character-sanitization`, and it
        // is a real false-positive source rather than a theoretical one: a lazy
        // `<!--…-->` never matches a comment with no closing marker, so everything
        // after it survives the strip and gets scanned as if it were live code. An
        // unterminated `<!--` comments out the rest of the document — so it has to
        // be consumed to the end of the file.
        const report = check(app(), {
            ...TREE,
            'web/dist/index.html': '<!doctype html>\n<!-- todo: window.genie is not a thing',
        });

        expect(find(report.findings, 'frontend.window-genie')).toBeUndefined();
    });

    it('catches a front end reaching for Node inside a sandboxed window', () => {
        const report = check(app(), {
            ...TREE,
            'web/dist/app.js': 'const { ipcRenderer } = window.require("electron");\n',
        });

        const finding = expectFinding(report.findings, 'frontend.node-api');
        expect(finding.problem).toMatch(/sandbox|no Node/i);
        expect(finding.fix).toContain('genieApp');
    });

    it('flags a browser permission Genie refuses wholesale', () => {
        const report = check(app(), {
            ...TREE,
            'web/dist/app.js': 'navigator.mediaDevices.getUserMedia({ video: true });\n',
        });

        const finding = expectFinding(report.findings, 'frontend.browser-permission');
        expect(finding.severity).toBe('advice');
        expect(finding.problem).toMatch(/camera|microphone|refus/i);
    });

    it('does not scan a PROXY front end for a built directory it never has', () => {
        const report = check(app({ frontend: { serve: { mode: 'proxy', hostPort: 5273 } } }), {
            'gapp.json': '',
        });

        expect(find(report.findings, 'frontend.no-index')).toBeUndefined();
    });
});

/**
 * The agents — genie#245 itself, checked before it ships rather than after.
 */
describe('the agent roster, against the slots that can run one', () => {
    const withAgents = (n: number, over: Record<string, unknown> = {}) =>
        app({
            agents: Array.from({ length: n }, (_, i) => ({
                name: `Agent ${i + 1}`,
                persona: `a${i + 1}.md`,
            })),
            ...over,
        });

    const personas = (n: number) =>
        Object.fromEntries(
            Array.from({ length: n }, (_, i) => [`.agents/a${i + 1}.md`, `# Agent ${i + 1}\nDo work.`]),
        );

    it('catches a roster bigger than the window can run', () => {
        // The user consents to a NAMED set at install. Getting fewer, silently, is
        // exactly the class of failure genie#245 was.
        const report = check(withAgents(3, { panels: { agents: 2 } }), {
            ...TREE,
            ...personas(3),
        });

        const finding = expectFinding(report.findings, 'agents.unreachable');
        expect(finding.severity).toBe('error');
        // The arithmetic, so the developer does not have to work it out.
        expect(finding.problem).toContain('3');
        expect(finding.problem).toContain('2');
        // WHICH agent never starts, by name.
        expect(finding.problem).toContain('Agent 3');
        expect(finding.fix).toContain('panels.agents');
    });

    it('catches a layout with no terminal slot at all, where NONE of them run', () => {
        const report = check(
            withAgents(1, { panels: { agents: 2, kinds: ['files', 'editor'] } }),
            { ...TREE, ...personas(1) },
        );

        const finding = expectFinding(report.findings, 'agents.unreachable');
        // The cause is not the count here, and saying "raise panels.agents" would
        // send the developer to change the wrong field.
        expect(finding.problem).toMatch(/terminal/i);
        expect(finding.fix).toContain('panels.kinds');
    });

    it('warns when one agent is cloned across several panels', () => {
        // Documented behaviour, not a bug — but three concurrent sessions of one
        // agent is three times the cost, and the cap refuses ALL of them if there
        // is no room.
        const report = check(withAgents(1, { panels: { agents: 3 } }), {
            ...TREE,
            ...personas(1),
        });

        const finding = expectFinding(report.findings, 'agents.cycled');
        expect(finding.severity).toBe('advice');
        expect(finding.problem).toContain('3');
        expect(finding.problem).toContain('Agent 1');
    });

    it('catches a persona file that is there but says nothing', () => {
        // An agent briefed with an empty file is the genie#245 window wearing a
        // name: a real TUI, launched, with no instructions at all.
        const report = check(withAgents(1), { ...TREE, '.agents/a1.md': '   \n\n' });

        const finding = expectFinding(report.findings, 'agents.persona-empty');
        expect(finding.severity).toBe('error');
        expect(finding.where).toContain('a1.md');
        expect(finding.problem).toContain('Agent 1');
    });

    it('says nothing about agents when the app ships none', () => {
        const report = check(app({ panels: { agents: 3 } }));
        expect(report.findings.filter((f) => f.check.startsWith('agents.'))).toEqual([]);
    });
});

/**
 * The services — reusing what the INSTALLER would configure, not a guess at it.
 */
describe('the services, as `appInstallPlan` would actually set them up', () => {
    const withService = (over: Record<string, unknown> = {}) =>
        app({
            services: [{ name: 'api', repo: 'service', command: ['node', 'server.mjs'] }],
            requires: [{ tool: 'node', reason: 'runs the api' }],
            ...over,
        });

    const served = { ...TREE, 'service/server.mjs': 'export {};' };

    it('passes a service whose entry is where the command says', () => {
        expect(check(withService(), served).findings).toEqual([]);
    });

    it('catches a command pointing at a file that is not there', () => {
        const report = check(withService(), { ...TREE, 'service/other.mjs': '' });

        const finding = expectFinding(report.findings, 'service.entry-missing');
        expect(finding.severity).toBe('error');
        expect(finding.problem).toContain('api');
        expect(finding.problem).toContain('server.mjs');
        // The path it looked at, so a wrong `repo` is visible from the message.
        expect(norm(finding.where)).toBe('C:/src/trader/service/server.mjs');
    });

    it('does not guess at arguments that are not file paths', () => {
        // ORR's is `uvicorn app:api`. A checker that demanded a file called
        // `app:api` would fail every Python app in the world.
        const report = check(
            withService({
                services: [{ name: 'api', repo: 'service', command: ['uvicorn', 'app:api'] }],
                requires: [{ tool: 'python', reason: 'runs the api' }],
            }),
            { ...TREE, 'service/app.py': '' },
        );

        expect(find(report.findings, 'service.entry-missing')).toBeUndefined();
    });

    it('catches two services with the same name', () => {
        const report = check(
            withService({
                services: [
                    { name: 'api', repo: 'service', command: ['node', 'server.mjs'] },
                    { name: 'api', repo: 'service', command: ['node', 'worker.mjs'] },
                ],
            }),
            { ...served, 'service/worker.mjs': '' },
        );

        const finding = expectFinding(report.findings, 'service.duplicate-name');
        expect(finding.problem).toContain('api');
        expect(finding.problem).toMatch(/label|supervis|replace/i);
    });

    it('catches two services fighting over one port', () => {
        const report = check(
            withService({
                services: [
                    { name: 'api', repo: 'service', command: ['node', 'server.mjs'], port: 8000 },
                    { name: 'worker', repo: 'service', command: ['node', 'worker.mjs'], port: 8000 },
                ],
            }),
            { ...served, 'service/worker.mjs': '' },
        );

        const finding = expectFinding(report.findings, 'service.port-clash');
        expect(finding.problem).toContain('8000');
        expect(finding.problem).toContain('api');
        expect(finding.problem).toContain('worker');
    });

    it('flags a runtime the service needs and the manifest never declared', () => {
        // Without the declaration the installer has nothing to say when the machine
        // has no python — the service simply never comes up.
        const report = check(
            withService({
                services: [{ name: 'api', repo: 'service', command: ['python', 'app.py'] }],
                requires: [],
            }),
            { ...TREE, 'service/app.py': '' },
        );

        const finding = expectFinding(report.findings, 'service.runtime-undeclared');
        expect(finding.severity).toBe('advice');
        expect(finding.problem).toContain('python');
        // The exact line to paste.
        expect(finding.fix).toContain('"tool": "python"');
    });
});

describe('the requirements', () => {
    it('says plainly when Genie can never install one', () => {
        const report = check(
            app({ requires: [{ tool: 'ffmpeg', reason: 'renders the video' }] }),
        );

        const finding = expectFinding(report.findings, 'requires.unmanaged');
        expect(finding.severity).toBe('advice');
        expect(finding.problem).toContain('ffmpeg');
        // Which ones it CAN, so a typo ("pyton") is obvious from the message.
        expect(finding.fix).toContain('python');
    });

    it('stays quiet about a runtime Genie manages', () => {
        const report = check(app({ requires: [{ tool: 'node', reason: 'runs it' }] }));
        expect(find(report.findings, 'requires.unmanaged')).toBeUndefined();
    });
});

describe('the tabs', () => {
    it('flags a tab that will 404 on a non-SPA front end', () => {
        const report = check(
            app({
                frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
                tabs: [{ title: 'Reports', path: '/reports' }],
            }),
        );

        const finding = expectFinding(report.findings, 'tabs.unresolved-path');
        expect(finding.problem).toContain('Reports');
        expect(finding.problem).toContain('/reports');
        expect(finding.fix).toContain('spa');
    });

    it('accepts any path once the app says it routes in the browser', () => {
        const report = check(
            app({
                frontend: { repo: 'web', serve: { mode: 'static', root: 'dist', spa: true } },
                tabs: [{ title: 'Reports', path: '/reports' }],
            }),
        );

        expect(find(report.findings, 'tabs.unresolved-path')).toBeUndefined();
    });

    it('flags two tabs the strip cannot tell apart', () => {
        const report = check(
            app({
                frontend: { repo: 'web', serve: { mode: 'static', root: 'dist', spa: true } },
                tabs: [
                    { title: 'Reports', path: '/a' },
                    { title: 'Reports', path: '/b' },
                ],
            }),
        );

        expect(expectFinding(report.findings, 'tabs.duplicate-title').problem).toContain('Reports');
    });
});

describe('what every finding owes the developer', () => {
    it('says what is wrong, where, and what to do — for all of them', () => {
        // The contract of the whole suite, asserted once over a folder broken in
        // as many ways as possible. Judge each by whether somebody who has never
        // read Genie's source could act on it.
        const report = check(
            app({
                panels: { agents: 1 },
                agents: [
                    { name: 'One', persona: 'one.md' },
                    { name: 'Two', persona: 'two.md' },
                ],
                services: [
                    { name: 'api', repo: 'service', command: ['python', 'app.py'], port: 80 },
                    { name: 'api', repo: 'service', command: ['node', 'x.mjs'], port: 80 },
                ],
                requires: [{ tool: 'ffmpeg' }],
                tabs: [{ title: 'A', path: '/a' }],
                permissions: { scope: 'workstation', capabilities: ['terminals'] },
            }),
            {
                'gapp.json': '',
                'web/dist/app.js': 'window.genie.call()',
                'service/x.mjs': '',
                '.agents/one.md': '# One',
                '.agents/two.md': '# Two',
            },
        );

        expect(report.findings.length).toBeGreaterThan(6);
        for (const finding of report.findings) {
            expect(finding.check).toBeTruthy();
            expect(finding.where, `where for ${finding.check}`).toBeTruthy();
            expect(finding.problem, `problem for ${finding.check}`).toBeTruthy();
            expect(finding.fix, `fix for ${finding.check}`).toBeTruthy();
            // A "fix" that only restates the problem is not an instruction. Every
            // one of these has to be long enough to tell somebody what to type.
            expect(finding.fix.length, `fix for ${finding.check}`).toBeGreaterThan(20);
        }
    });

    it('puts every error above every piece of advice', () => {
        const report = check(
            app({ permissions: { scope: 'workstation', capabilities: ['terminals'] } }),
            { 'gapp.json': '', 'web/dist/bundle.js': '' },
        );

        const severities = report.findings.map((f) => f.severity);
        expect(severities.indexOf('error')).toBe(0);
        expect(severities.lastIndexOf('error')).toBeLessThan(severities.indexOf('advice'));
    });
});

/**
 * A converted `.agi` envelope — a GApp Development Workspace (genie#268).
 *
 * Every tree above is a SCAFFOLDED staging folder, flat by construction, so none
 * of them can reach the envelope branch. The failure here is quieter than the
 * install gate's and worse for it: with the document root resolved flat, the root
 * simply "does not exist", so the front-end checks SKIP — and a suite that skipped
 * everything reports exactly what a clean one does. `ran` is what tells them apart.
 */
const ENVELOPE_TREE: Record<string, string> = {
    'gapp.json': '',
    'project.json': '{"name":"trader","repos":[{"name":"web"}]}',
    'repos/web/dist/index.html':
        '<!doctype html><html><body><script src="app.js"></script></body></html>',
    'repos/web/dist/app.js': 'const genie = window.genieApp;\n',
};

describe('a converted .agi envelope, whose components already live at repos/', () => {
    it('actually looks at the front end instead of silently skipping it', () => {
        const report = check(app(), ENVELOPE_TREE);

        expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
        expect(report.ok).toBe(true);
        // POSITIVE CONTROL. "No findings" is also what a suite that ran NOTHING
        // reports — which is precisely the bug in this layout. Naming the checks
        // that ran is the only thing that separates the two.
        expect(report.ran).toContain('frontend.no-index');
        expect(report.ran).toContain('frontend.window-genie');
    });

    it('still catches a document root with no index.html in it', () => {
        const { 'repos/web/dist/index.html': _removed, ...unbuilt } = ENVELOPE_TREE;
        const report = check(app(), unbuilt);

        const finding = expectFinding(report.findings, 'frontend.no-index');
        // And it names the place the developer is actually standing in.
        expect(norm(finding.where)).toContain('repos/web/dist');
    });
});

describe('a service inside a converted envelope', () => {
    const withService = () =>
        app({
            services: [{ name: 'api', repo: 'api', command: ['node', 'server.mjs'], port: 8791 }],
            requires: [{ tool: 'node', reason: 'runs the API' }],
        });

    const SERVICE_TREE: Record<string, string> = {
        ...ENVELOPE_TREE,
        'repos/api/server.mjs': 'export default 1;\n',
    };

    it('finds the entry file under repos/, where the envelope keeps it', () => {
        const report = check(withService(), SERVICE_TREE);

        expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);

        // POSITIVE CONTROL. `ran` is pushed whenever the app HAS services, so it
        // cannot tell "looked and found it" from "looked in the wrong place and
        // found nothing" — which is the exact failure here. Take the entry file
        // away from the same fixture: if the check is really running against
        // `repos/api`, it has to bite.
        const { 'repos/api/server.mjs': _removed, ...noEntry } = SERVICE_TREE;
        const control = check(withService(), { ...noEntry, 'repos/api/README.md': '' });
        expect(find(control.findings, 'service.entry-missing')).toBeDefined();
    });

    it('still catches a command whose entry file is not there', () => {
        const { 'repos/api/server.mjs': _removed, ...noEntry } = SERVICE_TREE;
        const report = check(withService(), { ...noEntry, 'repos/api/README.md': '' });

        const finding = expectFinding(report.findings, 'service.entry-missing');
        expect(norm(finding.where)).toContain('repos/api/server.mjs');
    });
});

describe('a PROXY front end inside a converted envelope', () => {
    // A proxy app ships source, not built output, so there is no serve root to fall
    // back from — the source scan is the only thing standing between a developer and
    // the `window.genie` mistake genie#245 was about. Resolved flat, the directory
    // "did not exist" in an envelope and the whole scan was skipped in silence.
    const proxy = () =>
        app({ frontend: { repo: 'web', serve: { mode: 'proxy', hostPort: 5273 } } });

    it('scans the component source where the envelope keeps it', () => {
        const report = check(proxy(), {
            'gapp.json': '',
            'project.json': '{"name":"trader"}',
            'repos/web/src/main.js': 'const g = window.genieApp;\n',
        });

        expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
        // POSITIVE CONTROL: the scan was actually reached. Without this, the clean
        // report above is indistinguishable from having looked at nothing.
        expect(report.ran).toContain('frontend.window-genie');
    });

    it('still catches window.genie in that layout', () => {
        const report = check(proxy(), {
            'gapp.json': '',
            'project.json': '{"name":"trader"}',
            'repos/web/src/main.js': 'const g = window.genie;\n',
        });

        expect(expectFinding(report.findings, 'frontend.window-genie').where).toContain('main.js');
    });
});
