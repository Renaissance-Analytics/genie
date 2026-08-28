/**
 * PURE. Checking a Genie App WITHOUT installing it (Tynn #250, P2).
 *
 * This is the loop a developer — or the agent writing the app — actually works
 * in: change something, ask whether it is right, fix what it says. Without it the
 * only feedback is an install that either refuses with schema errors or "succeeds"
 * and then serves a blank page, and those two look identical from outside.
 *
 * It checks what `validateAppManifest` structurally CANNOT: whether what the
 * manifest points at is actually there. A manifest can be perfectly valid and
 * describe an app that cannot possibly work.
 *
 * ## This is the INSTALL GATE
 *
 * Everything here is a reason the app cannot be installed or cannot come up at all,
 * which is why the installer, the previewer and the GitHub review all run it. The
 * developer-facing SUITE is `checkup.ts`, which runs this and then keeps going into
 * the checks that describe an app which installs fine and does not WORK. Keeping
 * the two apart is what lets the suite be stricter than the gate without making
 * Genie refuse apps it used to accept.
 *
 * ## Errors and advice are separate, deliberately
 *
 * An ERROR means it will not run. ADVICE means it will run and the developer
 * should think about it — a wide permission, a requirement with no explanation.
 * Merging them trains people to ignore both, and the one that gets ignored is
 * always the one that mattered.
 *
 * Every answer is a structured {@link AppFinding} — what is wrong, WHERE, and what
 * to DO about it — and `errors` / `advice` are derived views of that list, so the
 * callers that have always read strings keep working from the same single message.
 *
 * The filesystem is a probe so every branch is asserted rather than depending on
 * whatever happens to be on the box running the tests.
 */

import path from 'path';
import { findCapability } from './capabilities';
import {
    componentSourceDir,
    componentSourceSpelling,
    gappSourceLayout,
} from './install-plan';
import { findingLine, type AppFinding } from './findings';
import {
    APP_AGENTS_DIR,
    APP_MANIFEST_FILENAME,
    validateAppManifest,
    type AppManifest,
} from './manifest';

export interface FolderProbe {
    /** The raw `gapp.json`, or null when the folder has none. */
    readManifest: (folder: string) => string | null;
    exists: (absolutePath: string) => boolean;
    /**
     * Is ANOTHER installed app already serving this slug?
     *
     * `selfId` is passed so an app re-checking itself is not reported as
     * colliding with itself — which would make every reinstall look like a clash.
     */
    slugTaken: (slug: string, selfId: string) => boolean;
}

export interface AppFolderReport {
    ok: boolean;
    /** Every answer, structured. The two lists below are views of this one. */
    findings: AppFinding[];
    /** It will not run until these are fixed. */
    errors: string[];
    /** It will run. Worth a second thought anyway. */
    advice: string[];
    /** What the app is, when the manifest parsed — so a UI can show it. */
    app?: Pick<AppManifest, 'id' | 'slug' | 'name' | 'version' | 'description'>;
}

/** The report shape, built once from the findings so the two views cannot drift. */
function reportFrom(
    findings: AppFinding[],
    app?: AppFolderReport['app'],
): AppFolderReport {
    return {
        ok: !findings.some((f) => f.severity === 'error'),
        findings,
        errors: findings.filter((f) => f.severity === 'error').map(findingLine),
        advice: findings.filter((f) => f.severity === 'advice').map(findingLine),
        ...(app ? { app } : {}),
    };
}

export function validateAppFolder(folder: string, probe: FolderProbe): AppFolderReport {
    const raw = probe.readManifest(folder);
    if (raw === null) {
        return reportFrom([
            {
                check: 'manifest.missing',
                severity: 'error',
                where: path.join(folder, APP_MANIFEST_FILENAME),
                problem: `No ${APP_MANIFEST_FILENAME} here — this folder is not a Genie App.`,
                fix:
                    `Point the check at the folder that holds ${APP_MANIFEST_FILENAME}, or create ` +
                    'one with “Start a new app” in Settings → Genie Apps.',
            },
        ]);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return reportFrom([
            {
                check: 'manifest.json',
                severity: 'error',
                where: path.join(folder, APP_MANIFEST_FILENAME),
                problem: `${APP_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`,
                fix: 'Fix the syntax — a trailing comma or an unquoted key is the usual cause.',
            },
        ]);
    }

    const validated = validateAppManifest(parsed);
    if (!validated.ok) {
        // Straight through, one finding each. The validator's own messages already
        // name the field and say what it must be; re-writing them here would be a
        // second copy of the rule, and the two would disagree within a release.
        return reportFrom(
            validated.errors.map((message) => ({
                check: 'manifest.schema',
                severity: 'error' as const,
                where: path.join(folder, APP_MANIFEST_FILENAME),
                problem: message,
                fix: `Correct ${APP_MANIFEST_FILENAME} and check again — every field is documented in the Genie App SDK README.`,
            })),
        );
    }
    const manifest = validated.value;

    const findings: AppFinding[] = [];

    // --- Does what it points at exist? --------------------------------------
    //
    // The component folders checked below are exactly the ones `appCopyPlan`
    // enumerates, which is what makes this the right place to catch them: without
    // it, `copyAppSource` throws PARTWAY THROUGH an install, after the workspace
    // has already been created.
    //
    // WHERE they are depends on the folder's layout, which is why it is settled
    // once, up front, rather than guessed per component. A scaffolded staging
    // folder keeps them flat; a converted `.agi` envelope — a GDW — already keeps
    // them at `repos/<name>`. `install-plan` owns that rule and says why there.
    const layout = gappSourceLayout(folder, probe.exists);
    const frontendRepo = manifest.frontend.repo;
    const frontendDir = componentSourceDir(folder, layout, frontendRepo);

    if (frontendRepo !== undefined && !probe.exists(frontendDir)) {
        // "Build it first" is the wrong instruction when the component folder
        // itself is absent: no build produces a folder nobody created.
        findings.push({
            check: 'frontend.repo-missing',
            severity: 'error',
            where: frontendDir,
            problem: `The front end lives in "${frontendRepo}", but there is no such folder in this app.`,
            // Named in the terms of the layout the developer is STANDING IN. Told
            // the wrong one, they go looking for a duplicate of a folder already
            // in front of them — and correctly refuse to make it.
            fix:
                layout === 'envelope'
                    ? `Create it at \`${componentSourceSpelling(layout, frontendRepo)}\`, or correct \`frontend.repo\` — ` +
                      'this folder is an envelope, so its components live under `repos/`.'
                    : 'Create it, or correct `frontend.repo` — it names a folder beside the manifest, which lands at `repos/<name>` when the app installs.',
        });
    } else if (manifest.frontend.serve.mode === 'static') {
        // A proxy front end has no built output — it is a dev server the developer
        // runs — so this check applies only to `static`. Demanding a directory
        // would fail every app of the Ripple shape.
        const root = path.join(frontendDir, manifest.frontend.serve.root);
        if (!probe.exists(root)) {
            findings.push({
                check: 'frontend.root-missing',
                severity: 'error',
                where: root,
                problem: `The front end is served from "${manifest.frontend.serve.root}", but ${root} does not exist.`,
                fix: 'Build it first, or point `frontend.serve.root` at the directory you actually produce.',
            });
        }
    }

    manifest.services?.forEach((service, i) => {
        const dir = componentSourceDir(folder, layout, service.repo);
        if (!probe.exists(dir)) {
            findings.push({
                check: 'service.repo-missing',
                severity: 'error',
                where: dir,
                problem: `The service "${service.name}" runs in "${service.repo ?? '.'}", but ${dir} does not exist.`,
                fix: service.repo
                    ? `Create \`${componentSourceSpelling(layout, service.repo)}\`, or correct \`services[${i}].repo\`.`
                    : `Create that folder, or correct \`services[${i}].repo\`.`,
            });
        }
    });

    // The consequence that makes DECLARING agents worth its cost (owner,
    // 2026-08-22). They are declared in the manifest rather than discovered from
    // `.agents/`, because a GApp's agents run under the app's GRANTED
    // capabilities — a file appearing in the folder would add an agent nobody
    // agreed to, and a consent screen cannot describe a set it has to go looking
    // for. The accepted cost is two places to keep in step, and this check is what
    // stops them drifting silently: a declared agent with nothing behind it is the
    // same failure as a front end pointed at a `dist` nobody built.
    //
    // `.agents/` is ENVELOPE-owned, beside `repos/` and `project.json`. An agent
    // belongs to the app, not to any one of its repos, so it is never resolved
    // through `componentDir`.
    for (const agent of manifest.agents ?? []) {
        const persona = path.join(folder, APP_AGENTS_DIR, agent.persona);
        if (!probe.exists(persona)) {
            findings.push({
                check: 'agents.persona-missing',
                severity: 'error',
                where: persona,
                problem:
                    `The agent "${agent.name}" is declared with a persona at ` +
                    `"${APP_AGENTS_DIR}/${agent.persona}", but ${persona} does not exist.`,
                fix:
                    'Add the file, or drop the agent from `agents` — the user is asked to consent ' +
                    'to this roster, so it has to be real.',
            });
        }
    }

    // --- Is the address free? ------------------------------------------------
    if (probe.slugTaken(manifest.slug, manifest.id)) {
        // Two apps at one address is one app the user cannot reach, and the
        // failure would surface at hosting time, far from its cause.
        findings.push({
            check: 'slug.taken',
            severity: 'error',
            where: `${APP_MANIFEST_FILENAME} → slug`,
            problem: `Another installed app already serves ${manifest.slug}.gen.`,
            fix: 'Choose a different `slug`.',
        });
    }

    // --- Advice --------------------------------------------------------------
    if (manifest.permissions.scope === 'workstation') {
        findings.push({
            check: 'permissions.workstation-scope',
            severity: 'advice',
            where: `${APP_MANIFEST_FILENAME} → permissions.scope`,
            problem:
                '`scope: "workstation"` asks to act on EVERY workspace on the machine. That is the ' +
                'widest thing a user can grant.',
            fix: 'Ask for `self` unless the app is genuinely cross-project, and expect to justify it.',
        });
    }

    for (const key of manifest.permissions.capabilities) {
        const capability = findCapability(key);
        if (capability?.risk === 'high') {
            findings.push({
                check: 'permissions.high-risk',
                severity: 'advice',
                where: `${APP_MANIFEST_FILENAME} → permissions.capabilities`,
                problem: `“${capability.label}” is a high-risk permission — many users will decline it.`,
                fix: 'Make sure the app still works without it.',
            });
        }
    }

    (manifest.requires ?? []).forEach((requirement, i) => {
        if (!requirement.reason) {
            findings.push({
                check: 'requires.no-reason',
                severity: 'advice',
                where: `${APP_MANIFEST_FILENAME} → requires[${i}]`,
                problem:
                    `The requirement "${requirement.tool}" has no \`reason\`. When Genie cannot install it, ` +
                    'the user is asked to — and "install docker" is an instruction where ' +
                    '"install docker — it runs the sandbox" is a decision.',
                fix: `Add a \`reason\` to \`requires[${i}]\` saying what the app needs it for.`,
            });
        }
    });

    if (manifest.frontend.browserExposed) {
        findings.push({
            check: 'frontend.browser-exposed',
            severity: 'advice',
            where: `${APP_MANIFEST_FILENAME} → frontend.browserExposed`,
            problem:
                'This app asks to be reachable from the real browser, which costs the user a one-time ' +
                'admin prompt (a certificate and a hosts entry).',
            fix: 'Ask only if it needs to be — inside the Genie App window it is reachable either way.',
        });
    }

    return reportFrom(findings, {
        id: manifest.id,
        slug: manifest.slug,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
    });
}
