/**
 * PURE. The Genie App testing suite — what a DEVELOPER runs against their own app
 * before anybody installs it (genie#245 follow-on).
 *
 * ## What it is for
 *
 * genie#245: a developer followed the SDK README, shipped personas, installed, and
 * got N empty terminals with NO ERROR. Nothing told them anything was wrong. That
 * reads as a broken product rather than an unbuilt feature — and the reason it got
 * that far is that every gate in the chain was answering a different question.
 * `validateAppManifest` answers "is this schema valid". `validateAppFolder` answers
 * "can Genie install this". Neither answers the one a developer actually has:
 * **will this WORK when somebody installs it?**
 *
 * That is this module. It is a tool Genie provides, not a test of Genie.
 *
 * ## The line between this and `validate.ts`
 *
 *   `validateAppFolder`  the INSTALL GATE. Refusing here refuses an install, so it
 *                        holds only what makes an app uninstallable.
 *   `checkApp`           the SUITE. Free to be stricter, because nothing it says
 *                        blocks anything — it reports an app that installs
 *                        perfectly and then shows an empty window.
 *
 * The suite RUNS the gate rather than restating it. A checker carrying its own copy
 * of a rule disagrees with the installer the moment either changes, and then it
 * lies — which is worse than not existing. Same reason the roster arithmetic comes
 * from `agentPanelLayout` and the service layout from `appInstallPlan`: the answer
 * a developer gets here is the one Genie will actually act on.
 *
 * ## Failure output is the product
 *
 * The checks are the easy half. Every finding names WHERE to look, WHAT is wrong
 * and WHAT TO DO — see `findings.ts` for why the type forces all three. Judge each
 * message by whether somebody who has never read Genie's source could act on it.
 */

import path from 'path';
import { LANGUAGE_TOOLS, isLanguageTool } from '../dev-server/toolchain-versions';
import type { AppFinding } from './findings';
import {
    appInstallPlan,
    componentSourceDir,
    gappSourceLayout,
    type GappSourceLayout,
} from './install-plan';
import {
    APP_AGENTS_DIR,
    APP_MANIFEST_FILENAME,
    validateAppManifest,
    type AppManifest,
} from './manifest';
import { agentPanelLayout } from './panels';
import { validateAppFolder, type AppFolderReport, type FolderProbe } from './validate';

/**
 * The filesystem the suite reads, on top of the install gate's own probe.
 *
 * Injected for the same reason the gate's is: every branch is then asserted
 * directly instead of depending on what happens to be on the box running the
 * tests. The CAPS — skipping `node_modules`, refusing enormous files — belong to
 * the implementation, not here: they are I/O policy, and a fake that had to
 * reproduce them would be a second implementation of the thing under test.
 */
export interface CheckProbe extends FolderProbe {
    /** Every file under a directory, recursively, as absolute paths. */
    listFiles: (absoluteDir: string) => string[];
    /** A text file's contents, or null when it cannot be read as text. */
    readText: (absolutePath: string) => string | null;
}

export interface AppCheckReport {
    /** No errors. Advice does not make an app broken. */
    ok: boolean;
    /** Errors first, then advice. */
    findings: AppFinding[];
    /**
     * The checks that were EVALUATED, by id.
     *
     * So a clean report says what it covered rather than only that it found
     * nothing — "no errors" from a suite that silently skipped everything is the
     * same false reassurance this module exists to remove. `install-gate` stands
     * for the whole of `validateAppFolder`, which owns its own rules.
     */
    ran: string[];
    app?: AppFolderReport['app'];
}

/** The gate, as one entry in `ran` — it owns and reports its own rules. */
const INSTALL_GATE = 'install-gate';

/* ---- source scanning --------------------------------------------------- */

/** What is worth reading when looking for code that cannot work in a GApp window. */
const SOURCE_FILE = /\.(m?[jt]sx?|cjs|html?|vue|svelte)$/i;

/**
 * Comments stripped BEFORE matching.
 *
 * The shipped example names `window.genie` while explaining that it does not
 * exist, and a check that counted that as a use would be asserting something other
 * than what it says. A false positive on the reference app teaches developers to
 * ignore the whole suite, which costs more than the check is worth.
 *
 * ## An UNTERMINATED comment runs to the end of the file
 *
 * `(?:-->|$)` rather than `-->`, and `(?:\*\/|$)` rather than `*\/`, and both
 * halves of that matter. It is how a browser and a JS engine actually read an
 * unclosed comment — everything after it is commented out — so a lazy match that
 * simply failed would leave the whole remainder of the file to be scanned as live
 * code, and report a `window.genie` nobody wrote.
 *
 * It is also what stops the strip leaving a dangling `<!--` behind, which CodeQL
 * flags as `js/incomplete-multi-character-sanitization`: with the alternation
 * every opener is consumed, terminated or not.
 *
 * Whole-line `//` only — a naive `//` strip eats the rest of any line containing a
 * URL.
 */
function stripComments(source: string, file: string): string {
    const withoutHtml = /\.html?$/i.test(file)
        ? source.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        : source;
    return withoutHtml.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface SourceRule {
    check: string;
    severity: AppFinding['severity'];
    pattern: RegExp;
    problem: (file: string) => string;
    fix: string;
}

const SOURCE_RULES: readonly SourceRule[] = [
    {
        check: 'frontend.window-genie',
        severity: 'error',
        // `window.genieApp` is the real surface, so the boundary must not match it.
        pattern: /\b(?:window|globalThis)\.genie\b(?!App)/,
        problem: (file) =>
            `${file} reaches for \`window.genie\`. A Genie App window does not have one — ` +
            'the entire surface is `window.genieApp`, two calls, so this is `undefined` at ' +
            'runtime and the page dies before it renders anything.',
        fix:
            'Use `window.genieApp.me()` / `window.genieApp.call(tool, args)`, or `useGenie()` from ' +
            '`@genie/app-sdk`, which wraps exactly those two calls.',
    },
    {
        check: 'frontend.node-api',
        severity: 'error',
        // Deliberately narrow: the two spellings that mean somebody expected an
        // Electron renderer. A broader pattern — `window.process`, a bare
        // `require(` — matches the polyfills bundlers emit into perfectly good
        // front ends, and a false ERROR on a working app is how a developer learns
        // to ignore the whole suite.
        pattern: /\bwindow\.require\b|\brequire\(\s*['"]electron['"]\s*\)/,
        problem: (file) =>
            `${file} reaches for Node or Electron. A Genie App window runs in a full Chromium ` +
            'sandbox with no Node, no filesystem and no Electron API — that isolation is what ' +
            'makes installing a third-party app safe, and it is not relaxed for any app.',
        fix:
            'Ask Genie instead: `window.genieApp.call(...)`, under a capability the user granted ' +
            'at install. Anything Genie has no tool for cannot be reached from the window at all.',
    },
    {
        check: 'frontend.browser-permission',
        severity: 'advice',
        pattern: /navigator\.mediaDevices|getUserMedia|getDisplayMedia|navigator\.geolocation/,
        problem: (file) =>
            `${file} asks for a browser permission (camera, microphone, screen capture or ` +
            'location). Genie refuses those wholesale in an app window, so the promise rejects ' +
            'rather than prompting the user.',
        fix:
            'Drop it, or move the work behind a Genie tool where there is a grant to check. ' +
            'Design the app so the refusal is a state you render, not an exception you throw.',
    },
];

/** Every source file under a directory, read once, comments already gone. */
function scanSources(dir: string, probe: CheckProbe): AppFinding[] {
    const findings: AppFinding[] = [];
    for (const file of probe.listFiles(dir)) {
        if (!SOURCE_FILE.test(file)) continue;
        const raw = probe.readText(file);
        if (raw === null) continue;
        const code = stripComments(raw, file);
        for (const rule of SOURCE_RULES) {
            if (!rule.pattern.test(code)) continue;
            findings.push({
                check: rule.check,
                severity: rule.severity,
                // The FILE, not the app. "Your app uses window.genie" inside a dist
                // of forty files is a search, not a fix.
                where: file,
                problem: rule.problem(path.basename(file)),
                fix: rule.fix,
            });
        }
    }
    return findings;
}

/* ---- services ---------------------------------------------------------- */

/** A command argument that names a FILE, as opposed to a module or a flag. */
const ENTRY_ARG = /\.(m?[jt]sx?|cjs|py|rb|php|sh|pl|lua|go)$/i;

/**
 * The file a service's command runs, when the command names one at all.
 *
 * Conservative on purpose. ORR's service is `uvicorn app:api`, and a check that
 * demanded a file called `app:api` would fail every Python app there is. Only an
 * argument that unambiguously names a file is checked; everything else is left
 * alone rather than guessed at.
 */
export function serviceEntryFile(command: readonly string[]): string | null {
    for (const arg of command.slice(1)) {
        if (arg.startsWith('-')) continue;
        if (arg.includes(':')) continue;
        if (ENTRY_ARG.test(arg)) return arg.replace(/^\.[\\/]/, '');
    }
    return null;
}

/* ---- the suite --------------------------------------------------------- */

/** The manifest, or null when it is not valid — the gate has already said why. */
function parseManifest(folder: string, probe: CheckProbe): AppManifest | null {
    const raw = probe.readManifest(folder);
    if (raw === null) return null;
    try {
        const validated = validateAppManifest(JSON.parse(raw));
        return validated.ok ? validated.value : null;
    } catch {
        return null;
    }
}

export function checkApp(folder: string, probe: CheckProbe): AppCheckReport {
    // The REAL gate, first and unmodified. Whatever it says, the suite says.
    const gate = validateAppFolder(folder, probe);
    const manifest = parseManifest(folder, probe);

    const findings = [...gate.findings];
    const ran = [INSTALL_GATE];

    // A manifest that does not parse makes every check below meaningless: they
    // would all be reporting on a shape nobody has. The gate's schema findings are
    // the whole answer until it does.
    if (!manifest) return report(findings, ran, gate.app);

    let plan;
    try {
        // The workspace id is a placeholder — nothing here depends on it, and using
        // the REAL planner is the point: what gets checked is what the installer
        // will actually configure, not a second guess at it.
        plan = appInstallPlan('check', manifest);
    } catch (e) {
        findings.push({
            check: 'install.plan-failed',
            severity: 'error',
            where: path.join(folder, APP_MANIFEST_FILENAME),
            problem: `Genie could not work out how to install this app: ${(e as Error).message}`,
            fix: 'This is a bug in Genie, not in your app — please report it with your manifest attached.',
        });
        return report(findings, [...ran, 'install.plan-failed'], gate.app);
    }

    // Settled once, for the whole checkup: one folder has one layout, and a suite
    // that answered this question separately per check could contradict itself
    // about where the same component lives. `install-plan` owns the rule.
    const layout = gappSourceLayout(folder, probe.exists);

    checkFrontend(folder, layout, probe, manifest, plan, findings, ran);
    checkAgents(folder, probe, manifest, findings, ran);
    checkServices(folder, layout, probe, manifest, plan, findings, ran);
    checkRequirements(manifest, findings, ran);
    checkTabs(folder, layout, probe, manifest, plan, findings, ran);

    return report(findings, ran, gate.app);
}

function report(
    findings: AppFinding[],
    ran: string[],
    app: AppFolderReport['app'],
): AppCheckReport {
    // Errors above advice, always. A report that interleaves them is one where the
    // thing that matters is somewhere in the middle.
    const errors = findings.filter((f) => f.severity === 'error');
    const advice = findings.filter((f) => f.severity === 'advice');
    return {
        ok: errors.length === 0,
        findings: [...errors, ...advice],
        ran,
        ...(app ? { app } : {}),
    };
}

/**
 * Where the site's files will actually come from.
 *
 * Read off the INSTALL PLAN rather than recomputed from the manifest: the plan is
 * what the Site Manager is configured with, so a change to how a GApp is served
 * moves this check with it. The one translation is from the plan's bare component
 * name to wherever that component sits in THIS source folder — flat in a
 * scaffolded staging folder, `repos/<name>` in a converted envelope. Resolving it
 * flat regardless was quietly worse here than at the install gate: the root simply
 * "did not exist", so every front-end check below SKIPPED, and a suite that ran
 * nothing reports exactly what a clean one does.
 */
function documentRoot(
    folder: string,
    layout: GappSourceLayout,
    plan: ReturnType<typeof appInstallPlan>,
): string | null {
    const serve = plan.site.hostServe;
    if (!serve || serve.mode !== 'static' || !serve.root) return null;
    return path.join(componentSourceDir(folder, layout, plan.site.repo || undefined), serve.root);
}

function checkFrontend(
    folder: string,
    layout: GappSourceLayout,
    probe: CheckProbe,
    manifest: AppManifest,
    plan: ReturnType<typeof appInstallPlan>,
    findings: AppFinding[],
    ran: string[],
): void {
    const root = documentRoot(folder, layout, plan);

    if (root && probe.exists(root)) {
        ran.push('frontend.no-index');
        const index = path.join(root, 'index.html');
        if (!probe.exists(index)) {
            // The purest form of the failure this suite exists for: it installs,
            // the site starts, and the window opens on nothing at all.
            findings.push({
                check: 'frontend.no-index',
                severity: 'error',
                where: index,
                problem:
                    `The site is served from "${plan.site.hostServe?.root}" and there is no ` +
                    '`index.html` in it. Genie serves files from that directory, so the app window ' +
                    'would open on an empty page with no error on it — which reads as a broken app ' +
                    'rather than a missing file.',
                fix:
                    'Build your front end into that directory, or point `frontend.serve.root` at the one ' +
                    'that holds your `index.html`.',
            });
        }
    }

    // WHICH directory to read depends on how the app is served: a static app ships
    // the built output Genie serves, a proxy app ships the source its own dev
    // server runs. Both are the code that ends up in the window.
    const sourceDir =
        root && probe.exists(root)
            ? root
            : componentSourceDir(folder, layout, manifest.frontend.repo);
    if (probe.exists(sourceDir)) {
        for (const rule of SOURCE_RULES) ran.push(rule.check);
        findings.push(...scanSources(sourceDir, probe));
    }
}

function checkAgents(
    folder: string,
    probe: CheckProbe,
    manifest: AppManifest,
    findings: AppFinding[],
    ran: string[],
): void {
    const roster = manifest.agents ?? [];
    if (roster.length === 0) return;

    ran.push('agents.unreachable', 'agents.cycled', 'agents.persona-empty');

    // The REAL layout — the one `ensureAgentPanels` seeds from. Re-deriving "how
    // many agents actually run" is precisely the drift that produced genie#245.
    const layout = agentPanelLayout(manifest.panels, roster);
    const slots = layout.filter((panel) => panel.type === 'terminal').length;
    const bound = new Set(layout.flatMap((panel) => (panel.agent ? [panel.agent.name] : [])));
    const stranded = roster.filter((agent) => !bound.has(agent.name));

    if (stranded.length > 0) {
        const names = stranded.map((a) => `"${a.name}"`).join(', ');
        findings.push(
            slots === 0
                ? {
                      check: 'agents.unreachable',
                      severity: 'error',
                      where: `${APP_MANIFEST_FILENAME} → panels.kinds`,
                      problem:
                          `The app declares ${roster.length} agent(s) — ${names} — but none of ` +
                          `\`panels.kinds\` is a \`terminal\`. Only a terminal panel runs an agent; ` +
                          '`files` and `editor` are the code surface and the roster skips them. So ' +
                          'nothing in the roster ever starts, and the install screen still names them.',
                      fix:
                          'Add "terminal" to `panels.kinds` (or remove `panels.kinds` entirely — the ' +
                          'default is a terminal in every slot).',
                  }
                : {
                      check: 'agents.unreachable',
                      severity: 'error',
                      where: `${APP_MANIFEST_FILENAME} → panels.agents`,
                      problem:
                          `The app declares ${roster.length} agents but its Agent tab lays out ${slots} ` +
                          `slot(s) that can run one, so ${names} never start. The user is asked to ` +
                          'consent to the whole roster at install and would silently get fewer — ' +
                          'which is the failure declaring agents exists to prevent.',
                      fix:
                          `Raise \`panels.agents\` to ${roster.length} (8 is the maximum), or remove the ` +
                          'agents that will not run from `agents`.',
                  },
        );
    } else if (slots > roster.length) {
        // Documented behaviour, not a bug — but three sessions of one agent is three
        // times the cost, on someone else's subscription.
        findings.push({
            check: 'agents.cycled',
            severity: 'advice',
            where: `${APP_MANIFEST_FILENAME} → panels.agents`,
            problem:
                `\`panels.agents\` asks for ${slots} agent panels and the app declares ` +
                `${roster.length}, so the roster cycles: Genie runs ${slots} concurrent sessions of ` +
                `${roster.map((a) => `"${a.name}"`).join(', ')}. Each one counts against the user's ` +
                'agent-terminal limit, and if there is no room for all of them Genie starts NONE.',
            fix:
                `Lower \`panels.agents\` to ${roster.length} if you meant one session each, or declare ` +
                'the other agents in `agents`.',
        });
    }

    for (const agent of roster) {
        const persona = path.join(folder, APP_AGENTS_DIR, agent.persona);
        // A missing file is the gate's finding; this is the one it cannot see.
        if (!probe.exists(persona)) continue;
        const text = probe.readText(persona);
        if (text !== null && text.trim().length === 0) {
            findings.push({
                check: 'agents.persona-empty',
                severity: 'error',
                where: persona,
                problem:
                    `The persona for "${agent.name}" is empty. Genie launches a real coding agent ` +
                    'against this file, so an empty one is an agent with no instructions at all — ' +
                    'the same empty window as a missing persona, with a model session attached to it.',
                fix:
                    'Write what this agent is for, what it may touch and how it should behave. It is ' +
                    'read by whichever TUI the workstation uses, so keep it harness-neutral.',
            });
        }
    }
}

function checkServices(
    folder: string,
    layout: GappSourceLayout,
    probe: CheckProbe,
    manifest: AppManifest,
    plan: ReturnType<typeof appInstallPlan>,
    findings: AppFinding[],
    ran: string[],
): void {
    const services = manifest.services ?? [];
    if (services.length === 0) return;

    ran.push(
        'service.entry-missing',
        'service.duplicate-name',
        'service.port-clash',
        'service.runtime-undeclared',
    );

    const declared = new Set((manifest.requires ?? []).map((r) => r.tool.toLowerCase()));

    plan.processes.forEach((process, i) => {
        const service = services[i];
        if (!service) return;
        // `process.cwd` is the INSTALLED location (`repos/<name>`). Where that
        // component sits in the SOURCE folder is the layout's business, so it is
        // resolved from the manifest's own name through the shared resolver rather
        // than by running a string mapping backwards — which only ever produced the
        // flat answer, and so skipped this check entirely in an envelope.
        const dir = componentSourceDir(folder, layout, service.repo);
        // A missing directory is the gate's finding, and reporting the file inside
        // it as well would be two findings for one cause.
        if (probe.exists(dir)) {
            const entry = serviceEntryFile(process.command);
            if (entry && !probe.exists(path.join(dir, entry))) {
                findings.push({
                    check: 'service.entry-missing',
                    severity: 'error',
                    where: path.join(dir, entry),
                    problem:
                        `The service "${service.name}" runs \`${process.command.join(' ')}\`, but ` +
                        `there is no ${entry} in ` +
                        // The SOURCE folder, which is where the developer is
                        // looking. `process.cwd` is `repos/<name>` — the installed
                        // layout — and naming that would send them hunting for a
                        // folder they have not got yet.
                        `${service.repo ? `"${service.repo}"` : 'the app folder'}. Genie starts the ` +
                        'process anyway and it exits immediately, so the app installs and the backend ' +
                        'is simply never there.',
                    fix: `Add the file, or correct \`services[${i}].command\` — it is literal argv, so the first item is the program and the rest are its arguments.`,
                });
            }
        }

        const program = process.command[0];
        if (program && isLanguageTool(program) && !declared.has(program)) {
            findings.push({
                check: 'service.runtime-undeclared',
                severity: 'advice',
                where: `${APP_MANIFEST_FILENAME} → services[${i}].command`,
                problem:
                    `The service "${service.name}" runs \`${program}\`, but the manifest does not ` +
                    `\`require\` it. On a machine without ${program} the service will not start and ` +
                    'the installer has nothing to tell the user, because nothing said it was needed.',
                fix: `Add { "tool": "${program}", "reason": "runs ${service.name}" } to \`requires\`. Genie then installs it where it can, and asks the user where it cannot.`,
            });
        }
    });

    const byName = new Map<string, string[]>();
    for (const service of services) {
        const key = service.name.trim().toLowerCase();
        byName.set(key, [...(byName.get(key) ?? []), service.name]);
    }
    for (const [, names] of byName) {
        if (names.length < 2) continue;
        findings.push({
            check: 'service.duplicate-name',
            severity: 'error',
            where: `${APP_MANIFEST_FILENAME} → services`,
            problem:
                `${names.length} services are called "${names[0]}". Genie supervises background ` +
                'processes by label, so they collide: the second one takes the first one’s place and ' +
                'only one of them ever runs.',
            fix: 'Give each service its own `name` — it is the label the user sees in Processes, too.',
        });
    }

    const byPort = new Map<number, string[]>();
    const claim = (port: number | undefined, owner: string) => {
        if (port === undefined) return;
        byPort.set(port, [...(byPort.get(port) ?? []), owner]);
    };
    for (const service of services) claim(service.port, `"${service.name}"`);
    if (manifest.frontend.serve.mode === 'proxy') {
        claim(manifest.frontend.serve.hostPort, 'the front end (`frontend.serve.hostPort`)');
    }
    for (const [port, owners] of byPort) {
        if (owners.length < 2) continue;
        findings.push({
            check: 'service.port-clash',
            severity: 'error',
            where: `${APP_MANIFEST_FILENAME} → services`,
            problem:
                `${owners.join(' and ')} all declare port ${port}. Whichever starts second cannot ` +
                'bind it, so the app comes up half-running with no obvious reason why.',
            fix: 'Give each one a port of its own. They are ordinary local ports — pick anything free above 1024.',
        });
    }
}

function checkRequirements(manifest: AppManifest, findings: AppFinding[], ran: string[]): void {
    const requires = manifest.requires ?? [];
    if (requires.length === 0) return;
    ran.push('requires.unmanaged');

    requires.forEach((requirement, i) => {
        // Whether Genie can install a tool is a property of the MACHINE, resolved
        // per install by `resolveAppRequirements`. What IS decidable here is
        // whether Genie has any recipe for it at all — if it is not a language
        // Genie manages, every user on every platform is asked to provide it.
        if (isLanguageTool(requirement.tool)) return;
        findings.push({
            check: 'requires.unmanaged',
            severity: 'advice',
            where: `${APP_MANIFEST_FILENAME} → requires[${i}]`,
            problem:
                `Genie cannot install "${requirement.tool}" on any platform, so every user is asked ` +
                'to provide it themselves before the parts that need it will run. That is allowed — ' +
                'it is just worth knowing it is what you are asking for.',
            fix: `Keep the \`reason\`: it is the sentence they read when they are asked. Genie installs these itself: ${LANGUAGE_TOOLS.join(', ')}.`,
        });
    });
}

function checkTabs(
    folder: string,
    layout: GappSourceLayout,
    probe: CheckProbe,
    manifest: AppManifest,
    plan: ReturnType<typeof appInstallPlan>,
    findings: AppFinding[],
    ran: string[],
): void {
    const tabs = manifest.tabs ?? [];
    if (tabs.length === 0) return;
    ran.push('tabs.duplicate-title', 'tabs.unresolved-path');

    const seen = new Map<string, string>();
    for (const tab of tabs) {
        const key = tab.title.trim().toLowerCase();
        if (seen.has(key)) {
            findings.push({
                check: 'tabs.duplicate-title',
                severity: 'advice',
                where: `${APP_MANIFEST_FILENAME} → tabs`,
                problem:
                    `Two tabs are both called "${tab.title}". The strip shows titles and nothing ` +
                    'else — no address is ever exposed in a GApp window — so the user has no way to ' +
                    'tell them apart.',
                fix: 'Give each tab a title that says what is on it.',
            });
        }
        seen.set(key, tab.path);
    }

    // Only a STATIC, non-SPA front end resolves a path to a file. An SPA routes in
    // the browser and a proxy front end is somebody else's server, so in both cases
    // Genie has no idea what a path means and neither does this check.
    const serve = plan.site.hostServe;
    if (!serve || serve.mode !== 'static' || serve.spa) return;
    const root = documentRoot(folder, layout, plan);
    if (!root || !probe.exists(root)) return;

    for (const tab of tabs) {
        const relative = tab.path.replace(/^\//, '');
        if (relative === '') continue;
        const candidates = [
            path.join(root, relative),
            path.join(root, relative, 'index.html'),
            path.join(root, `${relative}.html`),
        ];
        if (candidates.some((candidate) => probe.exists(candidate))) continue;
        findings.push({
            check: 'tabs.unresolved-path',
            severity: 'advice',
            where: `${APP_MANIFEST_FILENAME} → tabs`,
            problem:
                `The tab "${tab.title}" opens ${tab.path}, and \`spa\` is off, so Genie serves it as ` +
                `a file — but there is no ${relative}, ${relative}/index.html or ${relative}.html in ` +
                'the served directory. The tab opens on a 404 inside the app window.',
            fix: 'Create that page, or set `frontend.serve.spa: true` if your front end routes the path in the browser.',
        });
    }
}
