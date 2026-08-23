/**
 * PURE. The install-time consent prompt, and how its answer is read (Tynn #250).
 *
 * The owner's model is a mobile app store: the app declares what it wants, the
 * user consents at install, nothing else is reachable. Genie's consent primitive
 * is the OS-modal ForceTheQuestion — drawn OUTSIDE the app's window, which is
 * exactly what makes it unfakeable by the app asking — and that modal takes at
 * most 4 questions of at most 4 options each.
 *
 * Fitting an arbitrary declaration into that shape has real edge cases (an app
 * asking for eight capabilities; an app asking for none), so it is decided here,
 * pure and tested, rather than assembled inline next to the install I/O.
 *
 * Fail-closed is the through-line: the permission question starts unselected, an
 * answer selecting nothing grants nothing, an unrecognised label grants nothing,
 * and a dismissed modal installs nothing at all.
 */

import { APP_CAPABILITIES, findCapability } from './capabilities';
import type { AppManifest, AppScope } from './manifest';
import type { AppRequirementPlan } from './requirements';
import type { ForceAnswer, ForceQuestion } from '../mcp/protocol';

/** The modal's own limit — the reason bundling exists at all. */
const MAX_OPTIONS = 4;

export interface ConsentPlan {
    questions: ForceQuestion[];
    /**
     * The header of the accept/decline question.
     *
     * Read back rather than assumed, because a PREVIEW's first question is not an
     * install question and must not be worded as one. Everything below it is
     * identical either way, which is the entire point of previewing behind the
     * real screen.
     */
    acceptHeader: string;
    /** Option label → the capabilities ticking it grants. */
    optionGrants: Record<string, string[]>;
    /** Option label → the reach choosing it grants. */
    scopeChoices: Record<string, { scope: AppScope; workspaces?: string[] }>;
    installLabel: string;
}

export interface ConsentOutcome {
    install: boolean;
    capabilities: string[];
    scope: AppScope;
    workspaces?: string[];
}

const DECLINE_LABEL = "Don't install";
const PREVIEW_DECLINE_LABEL = "Don't preview";

/**
 * What a PREVIEW does, in plain terms.
 *
 * The developer needs two facts that pull in opposite directions: this window is
 * REAL — its permissions are real, its terminals are real, whatever it is granted
 * it can actually do — and it is TEMPORARY, so saying yes does not put an app on
 * the machine. A screen that made only the first point would read as an install
 * prompt and get over-thought; one that made only the second would read as free
 * and not get read at all.
 */
function whatPreviewSetsUp(manifest: AppManifest): string {
    return [
        `- A temporary site at **${manifest.slug}.gen**, separate from any installed copy`,
        '- A throwaway workspace on the folder you are building in',
        '- **Nothing is installed.** No entry in your apps, no tray pill, nothing to ' +
            'uninstall — closing the window removes all of it',
    ].join('\n');
}

/** What the app will set up on this machine, in plain terms. */
function whatItSetsUp(manifest: AppManifest): string {
    const lines = [`- A site at **${manifest.slug}.gen**, served by Genie`];
    if (manifest.frontend.browserExposed) {
        lines.push('- Reachable from your normal browser, not only inside Genie');
    }
    for (const service of manifest.services ?? []) {
        lines.push(`- A background service, **${service.name}**`);
    }
    lines.push('- Its own workspace, which you can delete to remove it');
    return lines.join('\n');
}

/**
 * The loudest thing on the screen, when it applies.
 *
 * An app id is claimed by whoever writes the manifest, so replacing an installed
 * app with one from a different origin is a takeover of something the user already
 * trusts — a stranger's fork stepping into the shoes of an app they installed on
 * purpose. It goes ABOVE what the app sets up, because it changes the meaning of
 * everything below it.
 */
function originChangeWarning(context: ConsentContext): string {
    if (!context.replacing || !context.source) return '';
    return (
        `**This replaces an app you already have, and it came from somewhere else.**\n\n` +
        `- Installed from: \`${context.replacing.origin}\`\n` +
        `- This one is from: \`${context.source.origin}\`\n\n` +
        'If you did not expect that, stop here.\n\n'
    );
}

/**
 * The agents the app ships — the whole reason they are DECLARED (owner,
 * 2026-08-22).
 *
 * A GApp's agents run under the app's GRANTED capabilities. Discovering them from
 * `.agents/` would mean a file could add an agent nobody agreed to, and this
 * screen could not describe a set it had to go looking for. Declaring them buys
 * exactly one thing: this list. Leaving it off the screen would mean the cost of
 * declaration — two places to keep in step — bought nothing at all.
 *
 * The closing sentence is doing as much work as the names. Without it the roster
 * reads as trivia; with it, ticking a permission below is visibly ticking it for
 * these agents too.
 */
function agentsSection(manifest: AppManifest): string {
    const agents = manifest.agents ?? [];
    // Most GApps ship none, and a heading over an empty list is noise on the one
    // screen that has to stay readable.
    if (agents.length === 0) return '';
    const lines = agents.map(
        (a) => `- **${a.name}**${a.description ? ` — ${a.description}` : ''}`,
    );
    return (
        `\n\nIt ships ${agents.length === 1 ? 'an agent' : `${agents.length} agents`}, ` +
        'which run with the permissions you grant below:\n\n' +
        lines.join('\n')
    );
}

/**
 * The requirements section — the "distinctive spot in the installer" the owner
 * asked for. A runtime the user has to fetch themselves is a thing they need to
 * SEE, not a line that scrolls past in a log.
 */
function requirementsSection(requirements: AppRequirementPlan): string {
    const parts: string[] = [];
    if (requirements.genieInstalls.length > 0) {
        const list = requirements.genieInstalls
            .map((r) => `**${r.tool}**${r.version ? ` ${r.version}` : ''}`)
            .join(', ');
        parts.push(`\nGenie will install: ${list}.`);
    }
    if (requirements.userProvides.length > 0) {
        const list = requirements.userProvides
            .map((r) => `- **${r.tool}**${r.version ? ` ${r.version}` : ''}${r.reason ? ` — ${r.reason}` : ''}`)
            .join('\n');
        parts.push(
            `\n**You will need to install these yourself** — Genie cannot provide them on this machine. ` +
                `The app still installs; anything that needs them will not start until they are there.\n\n${list}`,
        );
    }
    return parts.join('\n');
}

/**
 * Group the requested capabilities into at most four options.
 *
 * Riskiest first, each on its own line for as long as there is room, and whatever
 * is left in ONE final bundle whose label says exactly what is in it. Bundling is
 * a presentation compromise forced by the modal, so it is applied to the tamest
 * permissions last — the ones that hand over the machine always get their own
 * decision — and every requested capability appears somewhere, because dropping
 * one silently is a permission the app asked for and the user never saw.
 */
function permissionOptions(capabilities: string[]): Array<{
    label: string;
    description: string;
    grants: string[];
}> {
    const ordered = capabilities
        .map((key) => findCapability(key))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .sort((a, b) => {
            if (a.risk !== b.risk) return a.risk === 'high' ? -1 : 1;
            return APP_CAPABILITIES.indexOf(a) - APP_CAPABILITIES.indexOf(b);
        });

    if (ordered.length <= MAX_OPTIONS) {
        return ordered.map((c) => ({
            label: c.label,
            description: c.grantDescription,
            grants: [c.key],
        }));
    }

    const individual = ordered.slice(0, MAX_OPTIONS - 1);
    const bundled = ordered.slice(MAX_OPTIONS - 1);
    return [
        ...individual.map((c) => ({
            label: c.label,
            description: c.grantDescription,
            grants: [c.key],
        })),
        {
            label: bundled.map((c) => c.label).join(', '),
            description: `${bundled.length} further permissions, granted together: ${bundled
                .map((c) => c.grantDescription)
                .join(' ')}`,
            grants: bundled.map((c) => c.key),
        },
    ];
}

export interface ConsentContext {
    /** The source an ALREADY-INSTALLED copy came from, when it differs. */
    replacing?: { origin: string };
    /** Where this copy comes from. */
    source?: { origin: string };
    /**
     * This is a PREVIEW, not an install.
     *
     * It changes the accept/decline question and NOTHING below it, and that
     * asymmetry is the feature. A developer who never sees their own consent
     * screen never learns what it says — so a preview shows the real one, with the
     * same permission wording, the same reach wording and the same bundling, and
     * differs only where being honest requires it.
     */
    preview?: boolean;
}

export function buildConsentPlan(
    manifest: AppManifest,
    requirements: AppRequirementPlan,
    context: ConsentContext = {},
): ConsentPlan {
    const preview = context.preview === true;
    // Both halves of the pair change together: a screen headed "Preview" whose
    // button still said "Install" would be the worst of the two.
    const acceptHeader = preview ? 'Preview' : 'Install';
    const installLabel = acceptHeader;
    const questions: ForceQuestion[] = [
        preview
            ? {
                  header: acceptHeader,
                  question:
                      `Preview the Genie App **${manifest.name}** (version ${manifest.version})?\n\n` +
                      'It opens in a real Genie App window with real permissions — but it is ' +
                      '**not installed**.\n\n' +
                      `${whatPreviewSetsUp(manifest)}\n` +
                      // The roster belongs on the preview screen too. A preview's
                      // grant is a REAL grant, so its agents really do run with the
                      // permissions ticked below, and the sentence that makes the
                      // list mean something is just as true here.
                      agentsSection(manifest) +
                      // The requirements section stays. A preview of an app whose
                      // runtime is missing is exactly where a developer wants to
                      // find that out, and it is the same text their users get.
                      requirementsSection(requirements),
                  options: [
                      {
                          label: installLabel,
                          description: `Open ${manifest.name} in a window. Nothing is installed.`,
                      },
                      {
                          label: PREVIEW_DECLINE_LABEL,
                          description: 'Nothing is created or changed.',
                      },
                  ],
              }
            : {
                  header: acceptHeader,
                  question:
                      `Install the Genie App **${manifest.name}** (version ${manifest.version})?\n\n` +
                      originChangeWarning(context) +
                      `${whatItSetsUp(manifest)}\n` +
                      agentsSection(manifest) +
                      requirementsSection(requirements),
                  options: [
                      {
                          label: installLabel,
                          description: `Set up ${manifest.name} on this machine.`,
                      },
                      { label: DECLINE_LABEL, description: 'Nothing is created or changed.' },
                  ],
              },
    ];

    const optionGrants: Record<string, string[]> = {};
    if (manifest.permissions.capabilities.length > 0) {
        const options = permissionOptions(manifest.permissions.capabilities);
        for (const option of options) optionGrants[option.label] = option.grants;
        questions.push({
            header: 'Permissions',
            question:
                `Which of these may **${manifest.name}** do?\n\n` +
                'Tick only what you want it to have. Nothing ticked means it can still run, ' +
                'but it cannot call Genie for anything. You can change this later in the app’s permissions.',
            multiSelect: true,
            options: options.map((o) => ({ label: o.label, description: o.description })),
        });
    }

    const scopeChoices: Record<string, { scope: AppScope; workspaces?: string[] }> = {};
    if (manifest.permissions.scope !== 'self') {
        const own = 'Only its own workspace';
        scopeChoices[own] = { scope: 'self' };
        const options: ForceQuestion['options'] = [
            {
                label: own,
                description: 'The narrowest choice. The app can still do everything it is for.',
            },
        ];

        if (manifest.permissions.scope === 'workspaces') {
            const named = manifest.permissions.workspaces ?? [];
            const label = `Also: ${named.join(', ')}`;
            scopeChoices[label] = { scope: 'workspaces', workspaces: named };
            options.push({
                label,
                description: `The app asked for these ${named.length} workspaces by name.`,
            });
        } else {
            const label = 'Every workspace on this machine';
            scopeChoices[label] = { scope: 'workstation' };
            options.push({
                label,
                description:
                    'The app asked to act across the whole workstation, including projects it knows nothing about.',
            });
        }

        questions.push({
            header: 'Reach',
            question:
                `How far may **${manifest.name}** reach?\n\n` +
                'This is separate from what it may DO. Its permissions apply only inside the workspaces you allow here.',
            options,
        });
    }

    return { questions, acceptHeader, optionGrants, scopeChoices, installLabel };
}

export function readConsent(
    plan: ConsentPlan,
    result: { cancelled: boolean; answers: ForceAnswer[] },
): ConsentOutcome {
    const nothing: ConsentOutcome = { install: false, capabilities: [], scope: 'self' };

    // A dismissed modal is not a yes. It is not even a question that was asked.
    if (result.cancelled) return nothing;

    const answerFor = (header: string) => result.answers.find((a) => a.header === header);
    // The plan's OWN header, not a literal: an install and a preview ask a
    // differently-worded first question, and a hardcoded 'Install' here would read
    // a preview's yes as a dismissal and silently create nothing.
    if (!answerFor(plan.acceptHeader)?.selected.includes(plan.installLabel)) return nothing;

    const capabilities: string[] = [];
    for (const label of answerFor('Permissions')?.selected ?? []) {
        // Only labels THIS plan produced can grant anything — a replayed or edited
        // answer naming something else grants nothing.
        for (const key of plan.optionGrants[label] ?? []) {
            if (!capabilities.includes(key)) capabilities.push(key);
        }
    }

    const reach = answerFor('Reach')?.selected[0];
    const chosen = (reach && plan.scopeChoices[reach]) || { scope: 'self' as AppScope };

    return {
        install: true,
        capabilities,
        scope: chosen.scope,
        ...(chosen.workspaces ? { workspaces: chosen.workspaces } : {}),
    };
}
