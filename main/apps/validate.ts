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
 * ## Errors and advice are separate, deliberately
 *
 * An ERROR means it will not run. ADVICE means it will run and the developer
 * should think about it — a wide permission, a requirement with no explanation.
 * Merging them trains people to ignore both, and the one that gets ignored is
 * always the one that mattered.
 *
 * The filesystem is a probe so every branch is asserted rather than depending on
 * whatever happens to be on the box running the tests.
 */

import path from 'path';
import { findCapability } from './capabilities';
import {
    APP_AGENTS_DIR,
    APP_MANIFEST_FILENAME,
    validateAppManifest,
    type AppManifest,
} from './manifest';

export interface FolderProbe {
    /** The raw `genie-app.json`, or null when the folder has none. */
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
    /** It will not run until these are fixed. */
    errors: string[];
    /** It will run. Worth a second thought anyway. */
    advice: string[];
    /** What the app is, when the manifest parsed — so a UI can show it. */
    app?: Pick<AppManifest, 'id' | 'slug' | 'name' | 'version' | 'description'>;
}

/** `repos/<name>` inside the SOURCE folder, or the folder itself. */
function componentDir(folder: string, repo: string | undefined): string {
    return repo ? path.join(folder, repo) : folder;
}

export function validateAppFolder(folder: string, probe: FolderProbe): AppFolderReport {
    const raw = probe.readManifest(folder);
    if (raw === null) {
        return {
            ok: false,
            errors: [`No ${APP_MANIFEST_FILENAME} here — this folder is not a Genie App.`],
            advice: [],
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            errors: [`${APP_MANIFEST_FILENAME} is not valid JSON: ${(e as Error).message}`],
            advice: [],
        };
    }

    const validated = validateAppManifest(parsed);
    if (!validated.ok) return { ok: false, errors: validated.errors, advice: [] };
    const manifest = validated.value;

    const errors: string[] = [];
    const advice: string[] = [];

    // --- Does what it points at exist? --------------------------------------
    if (manifest.frontend.serve.mode === 'static') {
        // A proxy front end has no built output — it is a dev server the developer
        // runs — so this check applies only to `static`. Demanding a directory
        // would fail every app of the Ripple shape.
        const root = path.join(
            componentDir(folder, manifest.frontend.repo),
            manifest.frontend.serve.root,
        );
        if (!probe.exists(root)) {
            errors.push(
                `The front end is served from "${manifest.frontend.serve.root}", but ${root} does not exist. ` +
                    'Build it first, or point `frontend.serve.root` at the directory you actually produce.',
            );
        }
    }

    for (const service of manifest.services ?? []) {
        const dir = componentDir(folder, service.repo);
        if (!probe.exists(dir)) {
            errors.push(
                `The service "${service.name}" runs in "${service.repo ?? '.'}", but ${dir} does not exist.`,
            );
        }
    }

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
            errors.push(
                `The agent "${agent.name}" is declared with a persona at ` +
                    `"${APP_AGENTS_DIR}/${agent.persona}", but ${persona} does not exist. ` +
                    'Add the file, or drop the agent from `agents` — the user is asked to consent ' +
                    'to this roster, so it has to be real.',
            );
        }
    }

    // --- Is the address free? ------------------------------------------------
    if (probe.slugTaken(manifest.slug, manifest.id)) {
        // Two apps at one address is one app the user cannot reach, and the
        // failure would surface at hosting time, far from its cause.
        errors.push(
            `Another installed app already serves ${manifest.slug}.gen. Choose a different \`slug\`.`,
        );
    }

    // --- Advice --------------------------------------------------------------
    if (manifest.permissions.scope === 'workstation') {
        advice.push(
            '`scope: "workstation"` asks to act on EVERY workspace on the machine. That is the ' +
                'widest thing a user can grant — ask for `self` unless the app is genuinely ' +
                'cross-project, and expect to justify it.',
        );
    }

    for (const key of manifest.permissions.capabilities) {
        const capability = findCapability(key);
        if (capability?.risk === 'high') {
            advice.push(
                `“${capability.label}” is a high-risk permission — many users will decline it. ` +
                    'Make sure the app still works without it.',
            );
        }
    }

    for (const requirement of manifest.requires ?? []) {
        if (!requirement.reason) {
            advice.push(
                `The requirement "${requirement.tool}" has no \`reason\`. When Genie cannot install it, ` +
                    'the user is asked to — and "install docker" is an instruction where ' +
                    '"install docker — it runs the sandbox" is a decision.',
            );
        }
    }

    if (manifest.frontend.browserExposed) {
        advice.push(
            'This app asks to be reachable from the real browser, which costs the user a one-time ' +
                'admin prompt (a certificate and a hosts entry). Ask only if it needs to be.',
        );
    }

    return {
        ok: errors.length === 0,
        errors,
        advice,
        app: {
            id: manifest.id,
            slug: manifest.slug,
            name: manifest.name,
            version: manifest.version,
            ...(manifest.description ? { description: manifest.description } : {}),
        },
    };
}
