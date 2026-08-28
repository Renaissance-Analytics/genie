/**
 * PURE. What an AGENT is told about the GApp Development Workspace it is sitting
 * in (genie#245 follow-on).
 *
 * ## Why this file exists at all
 *
 * GDW detection shipped complete: the column, the convergence rules
 * ({@link import('./gapp-dev').planGappDevSync}), the chrome, and two buttons in
 * Workspace Settings. Every test passed. And an agent working inside a real GDW
 * could not tell — it searched the tool registry, read the whole guide, opened
 * `project.json`, and found nothing, because `gapp_dev` never reached the MCP
 * layer. A capability no agent can discover is not a shipped capability; it is a
 * database column with chrome on it.
 *
 * So the unit of work here is the SENTENCE an agent reads, which is why it is a
 * pure function with its own tests rather than a string built inline at a call
 * site. The interesting cases — no manifest yet, not a GDW, no window to preview
 * into — are all about whether the reader can act on the answer, and those are
 * miserable to check through a live server.
 *
 * The impure half — resolving the row, reading the manifest, listing live
 * previews — is `main/mcp/gapp-dev-tools.ts`.
 */

/** The app a GDW's folder holds, as its manifest declares it. */
export interface GappDevAppFacts {
    name: string;
    slug: string;
    version: string;
}

/** A preview of this folder that is open right now. */
export interface GappDevPreview {
    appId: string;
    /** `https://<slug>.preview.gen/` — where it is actually serving. */
    homeUrl: string | null;
}

/** Everything Genie can say about the caller's workspace as a place a GApp is BUILT. */
export interface GappDevStatus {
    isGdw: boolean;
    /** The workspace root — the folder every app tool here points at. */
    root: string | null;
    workspaceName: string | null;
    /**
     * The Tynn project whose `is_gapp` decides this, or null when the workspace
     * is not linked to one. Null is a DIFFERENT answer from "linked and not a
     * GApp", and the agent's next move differs, so the two are never merged.
     */
    tynnProjectId: string | null;
    /** The manifest at the root, or null when the folder holds no app yet. */
    app: GappDevAppFacts | null;
    previews: readonly GappDevPreview[];
    /**
     * Can a preview window be opened from here at all?
     *
     * False on a headless host, which has no windows. Reported rather than left
     * to fail at call time: "nothing happened" is the exact failure this whole
     * surface is a reaction to.
     */
    previewAvailable: boolean;
}

/** The app tools, spelled the way the agent will type them. */
const CHECK = '`check`';
const PREVIEW = '`preview`';

/**
 * The full agent-facing answer to "am I in a GDW, and what can I do here".
 *
 * Always says what the workspace IS first, then what the agent can DO. A status
 * that reports a fact and offers no verb is the failure this replaces.
 */
export function formatGappDevStatus(status: GappDevStatus): string {
    const lines: string[] = [];

    if (!status.isGdw) {
        lines.push(
            `This workspace${status.workspaceName ? ` (${status.workspaceName})` : ''} is **not a GApp Development Workspace**.`,
        );
        lines.push('');
        lines.push(
            status.tynnProjectId === null
                ? 'It is **not linked to a Tynn project**, and the GDW flag has exactly one home: a human sets `is_gapp` on a Tynn project, and Genie converges on that answer. Link this workspace to a Tynn project first — there is no Genie-side setting to flip.'
                : `Its Tynn project (\`${status.tynnProjectId}\`) does not have \`is_gapp\` set. A human sets that flag in Tynn; Genie only converges on it. There is no Genie-side setting to flip.`,
        );
        lines.push('');
        lines.push(
            'Genie App development tools are not offered here. If you believe this IS where an app is built, ask the user to mark the Tynn project as a Genie App.',
        );
        return lines.join('\n');
    }

    lines.push(
        `This **IS a GApp Development Workspace** — the place the Genie App in this folder is BUILT (as opposed to a workspace where an installed app RUNS).`,
    );
    lines.push('');
    if (status.root) {
        lines.push(
            `- Source folder: \`${status.root}\` — every app tool here is already aimed at it, so no folder argument is needed.`,
        );
    }
    if (status.tynnProjectId) {
        lines.push(
            `- Declared by Tynn project \`${status.tynnProjectId}\` (\`is_gapp\`). Genie mirrors that flag; it is not set here.`,
        );
    }
    if (status.app) {
        lines.push(
            `- The app: **${status.app.name}** v${status.app.version}, slug \`${status.app.slug}\` (installed it would serve at \`https://${status.app.slug}.gen/\`).`,
        );
    } else {
        lines.push(
            '- No `gapp.json` here yet, so there is no app to check or preview. Writing that manifest is the first step — the folder is a GDW because a human said so, not because an app already exists.',
        );
    }

    for (const p of status.previews) {
        lines.push(
            `- A preview is OPEN right now: \`${p.appId}\`${p.homeUrl ? ` at ${p.homeUrl}` : ''}.`,
        );
    }

    lines.push('');
    // "…without hunting for a human" rather than "without a human": `preview`
    // still raises the app's own permission modal, and the line below says so.
    // Overstating it here would teach an agent that consent is not in the loop,
    // which is the one thing this tool must not do.
    lines.push('**What you can do here, without a human clicking through Settings:**');
    lines.push(
        `- \`manageGappDev\` ${CHECK} — run the full check suite over this folder (manifest, files, agents, services, front end). Stricter than the installer on purpose: it catches the app that installs cleanly and then opens on an empty window.`,
    );
    if (status.previewAvailable) {
        lines.push(
            `- \`manageGappDev\` ${PREVIEW} — open the app in a real GApp window on the LIVE source, under its own \`<slug>.preview\` identity and address, so it cannot collide with an installed copy. The user answers a permissions modal the first time the app's asks change; that consent is theirs, not yours.`,
        );
        lines.push(
            '- `manageGappDev` `close-preview` — tear one down. Closing the window does the same thing.',
        );
    } else {
        lines.push(
            `- Genie **cannot open a preview** on this host: ${PREVIEW} needs a desktop window, and this host has none. Run ${CHECK} instead, and leave previewing to a desktop Genie.`,
        );
    }
    return lines.join('\n');
}

/** What the tool may do, and — when it may not — the sentence the agent is given. */
export interface GappDevDecision {
    allowed: boolean;
    /** Surfaced verbatim on refusal. Empty when allowed. */
    reason: string;
}

const ALLOW: GappDevDecision = { allowed: true, reason: '' };

/**
 * PURE. May this action run against this workspace?
 *
 * Every refusal has to leave the agent able to do something next, which is why
 * the asymmetries here matter more than the rule:
 *
 *  - **`status` is never refused.** It is the question an agent asks BEFORE it
 *    knows anything, so gating it on the answer makes the answer unobtainable —
 *    the precise trap this whole surface exists to get out of.
 *  - **`check` survives a missing manifest.** The suite's job is to say what is
 *    wrong; refusing it because the thing it reports missing is missing would
 *    leave a developer with no way to be told.
 *  - **`preview` does not.** There is nothing to open, and "it opened nothing"
 *    is indistinguishable from a Genie bug.
 */
export function decideGappDevAction(
    status: GappDevStatus,
    action: 'status' | 'check' | 'preview' | 'close-preview',
): GappDevDecision {
    if (!status.root) {
        return {
            allowed: false,
            reason: 'This terminal is not attached to a Genie workspace, so there is no folder for the app tools to point at.',
        };
    }
    if (action === 'status') return ALLOW;

    if (!status.isGdw) {
        return {
            allowed: false,
            reason:
                'This workspace is not a GApp Development Workspace, so Genie does not know which app you mean. ' +
                (status.tynnProjectId === null
                    ? 'It is not linked to a Tynn project; link it first.'
                    : `Its Tynn project (\`${status.tynnProjectId}\`) does not have \`is_gapp\` set.`) +
                ' A human sets `is_gapp` in Tynn and Genie converges on it — there is no Genie-side setting to flip.',
        };
    }

    if (action === 'preview') {
        if (!status.app) {
            return {
                allowed: false,
                reason: `There is no \`gapp.json\` in ${status.root}, so there is no app to preview yet. Write the manifest first, then run \`check\`.`,
            };
        }
        if (!status.previewAvailable) {
            return {
                allowed: false,
                reason: 'A preview needs a desktop window and this host has none. Run `check` here and preview from a desktop Genie.',
            };
        }
    }

    return ALLOW;
}

/**
 * The single line the workspace map carries, or null when there is nothing to say.
 *
 * Null rather than "not a GDW" because orientation lists what a workspace IS: a
 * line on every ordinary workspace announcing an absence would be noise on the
 * one surface an agent reads before it knows anything.
 */
export function gappDevBrief(status: GappDevStatus): string | null {
    if (!status.isGdw) return null;
    const app = status.app ? `**${status.app.name}** v${status.app.version}` : 'no manifest yet';
    return `This is a **GApp Development Workspace** — a Genie App is BUILT here (${app}). Call \`manageGappDev\` (\`status\`) for what you can do with it.`;
}
