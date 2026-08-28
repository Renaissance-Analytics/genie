/**
 * PURE. The GApp manifest (`gapp.json`) — what a Genie App IS, and what it
 * may ask for (Tynn #250).
 *
 * A GApp is a whole agentic application: its own workspace, its own hosting, its
 * own front end in its own window, reaching Genie's tool surface under a scope the
 * user consents to at install. That makes this a SECURITY boundary before it is a
 * schema, so validation is strict and itemised — a bad manifest is rejected loudly
 * at install, never half-loaded. Mirrors `plugins/manifest.ts`, deliberately: the
 * GApp system extends the plugin trust model rather than inventing a second one.
 *
 * ## Shaped by the real apps, not a simplified idea of one
 *
 * The two target GApps are `.agi` envelopes with multiple repos and stacks:
 *
 *   - AI Trader ORR Jdun — a `python-fastapi` backend AND an `electron-react-ts`
 *     front end, served static at `orr.gen`.
 *   - The Ripple Effect — a live "artboard" at `ripple.gen` that other AGENTS
 *     watch, pointed at an already-running dev server via `hostPort`.
 *
 * So a GApp is MULTI-COMPONENT and MULTI-STACK. The manifest describes a front end
 * plus optional backend services and declares into the envelope's EXISTING
 * `project.json` sites/services shape — it does not invent a parallel hosting
 * model, because the one Genie has is already what these apps run on.
 */

import {
    APP_CAPABILITIES,
    UNGRANTABLE_TOOLS,
    capabilityForTool,
    findCapability,
    isAppCapability,
} from './capabilities';

export const APP_MANIFEST_FILENAME = 'gapp.json';

/**
 * Names a GApp may not take.
 *
 * The hard anti-impersonation gate. A GApp that can call itself Genie trades on
 * Genie's authority — it can ask for approvals, credentials or trust that were
 * never granted to it, and the user has no way to tell the difference. The
 * structural half of this protection is that consent prompts are OS-modal and
 * drawn OUTSIDE the GApp's window; this is the naming half.
 */
export const RESERVED_APP_NAMES: readonly string[] = [
    'genie',
    'genie app',
    'genie apps',
    'gapp',
    'tynn',
    'aionima',
];

/**
 * Labels Genie draws for ITSELF in a GApp window's tab strip (genie#264).
 *
 * The second half of the gate above, and it exists for the same reason. The strip
 * is `[Agent (Genie's)] [app tabs…] [Flows (Genie's)]`, and every button in it is
 * styled identically — the only thing that varies is which one is active.
 * `gapp.tsx` states why Flows is Genie's outright: *"an app must not be able to
 * paint the screen that says what it is allowed to do."*
 *
 * An app cannot paint the real one. Before this list it could put a convincing
 * TWIN immediately beside it — same treatment, same strip, its own content — and
 * a human had nothing to tell them apart. `window-title.ts` already filters a
 * RUNTIME title on the reasoning that "a page can set its title to anything"; the
 * declared path is the easier one and was unguarded.
 *
 * Lower-case, because comparison is normalised the same way names are.
 */
export const RESERVED_TAB_TITLES: readonly string[] = ['agent', 'flows'];

/** How a GApp's front end is served. Both shapes are in live use today. */
export type AppServe =
    /** A built directory served by Genie (ORR: `dist`). */
    | { mode: 'static'; root: string; spa?: boolean }
    /** An already-running dev server Genie fronts (Ripple: `hostPort: 5273`). */
    | { mode: 'proxy'; hostPort: number };

export interface AppFrontend {
    /** Repo within the envelope, or absent for the workspace root. */
    repo?: string;
    serve: AppServe;
    /** Reach it from a REAL browser, not only the Genie window. */
    browserExposed?: boolean;
}

/**
 * A backend the GApp needs running. LITERAL argv, never a shell string, and
 * never assumed to be Node — ORR's is `uvicorn`.
 */
export interface AppService {
    name: string;
    repo?: string;
    command: string[];
    port?: number;
}

/** Which workspaces a GApp's agent surface may act on. */
export type AppScope = 'self' | 'workspaces' | 'workstation';

/**
 * Whose agents may CALL this app's offered tools.
 *
 * The same three reaches as {@link AppScope}, answering the opposite question —
 * see {@link AppPermissions.consumers} for why that is a separate field and not a
 * second meaning bolted onto `scope`. A distinct alias because the two are read at
 * a glance in the same file and confusing them inverts a permission.
 */
export type AppConsumerScope = 'self' | 'workspaces' | 'workstation';

/** Who may spend this app's compute. See {@link AppPermissions.consumers}. */
export interface AppConsumers {
    scope: AppConsumerScope;
    /** Required when scope is `workspaces` — the explicit allow-list. */
    workspaces?: string[];
}

export interface AppPermissions {
    scope: AppScope;
    /** Required when scope is `workspaces` — the explicit allow-list. */
    workspaces?: string[];
    /**
     * The capabilities the app ASKS for (see `capabilities.ts`) — never tool
     * names, which are not something a consent prompt can be written about. Empty
     * means the app reaches no Genie tool at all; the user grants a subset of this
     * at install, and the bridge enforces the granted subset, not this one.
     */
    capabilities: string[];
    /**
     * Whose agents may call the tools in {@link AppManifest.contributes}.
     *
     * The INVERSE of `scope`, and deliberately not folded into it. `scope` answers
     * "whose workspace may this app touch?" — a grant the user makes TO the app.
     * `consumers` answers "whose agents may spend this app's compute?" — a grant
     * made ABOUT it. An app can legitimately be `scope: self` while being callable
     * from everywhere: a renderer touches nothing but its own workspace, and the
     * whole reason it exists is for other workspaces' agents to call it. One field
     * cannot carry both without one of them being wrong.
     *
     * Absent on an app that offers tools means `self` — the narrowest answer, like
     * every other permission here. Absent on an app that offers none stays absent.
     */
    consumers?: AppConsumers;
}

/** One MCP tool a GApp offers to agents. Same descriptor shape plugins use. */
export interface AppMcpTool {
    /** Bare slug; namespaced at runtime → `${slug}.${name}`. */
    name: string;
    /** What a CALLING agent reads to decide whether to reach for it. */
    description: string;
    /** JSON Schema for the arguments (an object schema). */
    inputSchema: Record<string, unknown>;
}

/**
 * How Genie reaches the service that implements the tools.
 *
 * Said explicitly rather than inferred, because a stdio MCP server does not fit
 * `services[]` — that shape assumes a port-based daemon, and a renderer's tool
 * server usually is not one.
 */
export type AppToolTransport = { kind: 'stdio' } | { kind: 'http'; port: number };

/**
 * What a GApp offers OUTWARD — the capability-provider block.
 *
 * `gapp-agents-runtime.md` already describes this kind of app: "Some GApps don't
 * even have agents but provide tools to agents like Remotion." The manifest had no
 * way to say it, and unrecognised keys were silently reconstructed away, so such a
 * manifest installed cleanly and its tools did not exist.
 *
 * The vocabulary is `genie-plugin.json`'s on purpose. The right question was never
 * "should this be a plugin?" — the plugin worker is deliberately incapable (a 30s
 * call timeout, no `child_process`, no subprocess) and should stay that way, so a
 * renderer cannot live there. It is "why can a plugin do what a GApp cannot?", and
 * the answer was only ever a missing bridge: everything a renderer needs is
 * already on this side — `services[]` with literal argv in any language and real
 * OS authority, `requires[]` for the toolchain.
 */
export interface AppContributes {
    /** The tools, in the order the app listed them. */
    mcpTools: AppMcpTool[];
    /**
     * WHICH declared service implements them — a name in `services`.
     *
     * The tools are served by a process the APP owns rather than by a Genie
     * worker, and that is exactly what buys them minutes of runtime and subprocess
     * authority. So the service has to exist, and this says which one it is.
     */
    servedBy: string;
    transport: AppToolTransport;
}

/**
 * The agent-facing name of a tool a GApp offers: `<slug>.<tool>`.
 *
 * Namespaced by the app's own SLUG rather than by a second `namespace` field the
 * way plugins do it. The slug is already the app's identity and already has to be
 * a unique DNS label — it is the address the user visits — so `remotion.renderVideo`
 * is a name a caller can predict from the app they installed, and there is no
 * second name to keep unique.
 */
export function appToolName(slug: string, tool: string): string {
    return `${slug}.${tool}`;
}

/**
 * A runtime or tool the app needs to RUN (owner-directed).
 *
 * Declared, never resolved here: whether Genie can provide it depends on the
 * machine (Python installs on Windows x64 today and not on macOS), so the
 * manifest states the need and `resolveAppRequirements` answers it per machine.
 * A missing one does NOT block the install — the app lands and the service that
 * needs it is reported unstartable, with what to install shown prominently.
 */
export interface AppRequirementDecl {
    tool: string;
    version?: string;
    /** WHY it is needed. Shown when the user has to provide it themselves —
     *  "install Docker" is an instruction; "install Docker — it runs the strategy
     *  sandbox" is a decision they can make. */
    reason?: string;
}


/**
 * The panel kinds a GApp's Agent tab can lay out — the same surfaces a workspace
 * has, because a GApp IS a workspace with extras.
 */
export const APP_PANEL_KINDS: readonly string[] = ['terminal', 'files', 'editor'];

/** How much of Genie's own panel management the app's first tab lays out. */
export interface AppPanels {
    /**
     * Concurrent agent panels. Defaults to ONE, never zero: the Agent tab exists
     * for every GApp, and zero would render an empty tab nobody asked for.
     */
    agents: number;
    /** Which surfaces to offer. Absent means Genie's own default set. */
    kinds?: string[];
}

/**
 * A tab the APP serves, rendered to the RIGHT of the Agent tab.
 *
 * `path` is relative to the app's own `<slug>.gen` origin, and is required to be:
 * a tab is Genie chrome wearing this app's name, and pointing one at another
 * origin would hand somebody else that frame.
 */
export interface AppTab {
    title: string;
    path: string;
}

/**
 * The folder inside a `.gapp` envelope holding one file (or directory) per agent.
 *
 * Envelope-owned, beside `repos/` and `project.json` — an agent belongs to the
 * APP, not to any one of its repos, and it travels with the app the way its
 * services do.
 */
export const APP_AGENTS_DIR = '.agents';

/**
 * One agent a GApp ships.
 *
 * DECLARED here rather than discovered by reading `.agents/` (owner, 2026-08-22).
 * Discovery is the ecosystem convention and it keeps one source of truth, so the
 * reason it lost is worth stating: a GApp's agents run under the app's GRANTED
 * capabilities, so a file appearing in `.agents/` would add an agent nobody agreed
 * to, and a consent screen cannot describe a set it has to go looking for.
 * Declaration is also what every other GApp capability already does —
 * `capabilities`, `panels`, `tabs`, `services`, `requires` — so this keeps one
 * rule rather than two.
 *
 * The accepted cost is two places to keep in step when an agent is added. What
 * stops them drifting is `validateAppFolder`: a declared agent whose persona file
 * is missing fails the folder check, in the same breath as a front end pointed at
 * a `dist` nobody built.
 */
export interface AppAgentDecl {
    /** What the consent screen calls it. Unique within the manifest. */
    name: string;
    /** Path to its persona, RELATIVE to `.agents/`. */
    persona: string;
    /** One line: what this agent is for. Shown at install. */
    description?: string;
}

export interface AppManifest {
    /** Exact shared schema revision used when Genie last authored this file. */
    $schema?: string;
    /** Reverse-DNS, globally unique. */
    id: string;
    /** DNS label — it becomes `<slug>.gen`, so it must be servable. */
    slug: string;
    name: string;
    version: string;
    description?: string;
    frontend: AppFrontend;
    services?: AppService[];
    /** Runtimes/tools this app needs to run. */
    requires?: AppRequirementDecl[];
    /** How the app's Agent tab is laid out. */
    panels: AppPanels;
    /** Extra tabs the app serves, in the order the strip shows them. */
    tabs?: AppTab[];
    /** The agents this app ships, each with a persona under `.agents/`. */
    agents?: AppAgentDecl[];
    /** The tools this app offers to OTHER agents. Absent for most apps. */
    contributes?: AppContributes;
    permissions: AppPermissions;
}

/**
 * Every key `gapp.json` has a meaning for — and the reason an unknown one is
 * an ERROR.
 *
 * `validateAppManifest` rebuilds a fresh object from the fields below, so anything
 * it does not recognise never reaches the runtime. Dropping it silently is the
 * worst of both: the manifest reads as though it declared something, the install
 * reports success, and the thing simply does not exist — with no error at any
 * point. That is the failure the capability-provider finding actually hit, and it
 * is the same argument `validateCapabilities` already makes one level down about
 * an unknown capability name.
 *
 * `$schema` is allowed because editors write it and Genie does not read it.
 */
const KNOWN_MANIFEST_KEYS: readonly string[] = [
    '$schema',
    'id',
    'slug',
    'name',
    'version',
    'description',
    'frontend',
    'services',
    'requires',
    'panels',
    'tabs',
    'agents',
    'contributes',
    'permissions',
];
const KNOWN_PERMISSION_KEYS: readonly string[] = [
    'scope',
    'workspaces',
    'capabilities',
    'consumers',
];
const KNOWN_CONSUMER_KEYS: readonly string[] = ['scope', 'workspaces'];
const KNOWN_CONTRIBUTES_KEYS: readonly string[] = ['mcpTools', 'servedBy', 'transport'];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const REVERSE_DNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
/** A DNS label: what can legally become `<slug>.gen`. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
/** A window is a layout, not an appetite. */
const MAX_AGENT_PANELS = 8;
/**
 * A roster is something the user has to READ.
 *
 * Every declared agent is a line on the consent screen, and the failure mode
 * consent exists to prevent is a screen nobody finishes. Same reasoning as the
 * panel cap, applied to the other half of the pair.
 */
const MAX_DECLARED_AGENTS = 16;
/**
 * How long a tab label may be, and how many there may be.
 *
 * Not tidiness — the same gate as the reserved titles, reached by size instead of
 * by wording. The strip is flex, and Genie's own Flows tab is APPENDED LAST, so an
 * app does not have to imitate the surface that says what it may do if it can push
 * it off the end of the window instead. Thirty-two characters is longer than any
 * real label (Genie's own are five) and eight tabs is more than a strip anyone
 * reads — the same "a window is a layout, not an appetite" reasoning as the panel
 * and agent caps above.
 *
 * A bound on what may be DECLARED is all a manifest can offer; the guarantee that
 * Genie's own tabs stay reachable at any width belongs to the renderer, which
 * keeps them from shrinking (`gapp.tsx`).
 */
const MAX_TAB_TITLE = 32;
const MAX_APP_TABS = 8;
/**
 * The name is a tab label too. `appWindowTabs` falls back to `manifest.name` when
 * an app declares no tabs, so an unbounded name is the same overflow through a
 * simpler manifest. Roomier than a tab title because a name is also the window's
 * grouping prefix, and still bounded for the same reason.
 */
const MAX_APP_NAME = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** One normalisation for every label comparison — casing and padding immune. */
const normalizeLabel = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Reserved-name comparison, immune to casing and padding. */
export function claimsReservedName(name: string): boolean {
    return RESERVED_APP_NAMES.includes(normalizeLabel(name));
}

/** Does this label claim one of GENIE'S OWN tabs? Same normalisation. */
export function claimsGenieTabTitle(title: string): boolean {
    return RESERVED_TAB_TITLES.includes(normalizeLabel(title));
}

function validateFrontend(raw: unknown, errors: string[]): AppFrontend | null {
    if (!isRecord(raw)) {
        errors.push('`frontend` is required (an object with a `serve` block)');
        return null;
    }
    const serve = raw.serve;
    if (!isRecord(serve)) {
        errors.push('`frontend.serve` is required');
        return null;
    }

    if (serve.mode === 'static') {
        if (!nonEmpty(serve.root)) {
            errors.push('`frontend.serve.root` is required for a static front end');
            return null;
        }
        return {
            ...(nonEmpty(raw.repo) ? { repo: raw.repo } : {}),
            serve: {
                mode: 'static',
                root: serve.root,
                ...(serve.spa === true ? { spa: true } : {}),
            },
            ...(raw.browserExposed === true ? { browserExposed: true } : {}),
        };
    }

    if (serve.mode === 'proxy') {
        const port = serve.hostPort;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            errors.push('`frontend.serve.hostPort` must be a port number for a proxy front end');
            return null;
        }
        return {
            ...(nonEmpty(raw.repo) ? { repo: raw.repo } : {}),
            serve: { mode: 'proxy', hostPort: port },
            ...(raw.browserExposed === true ? { browserExposed: true } : {}),
        };
    }

    errors.push('`frontend.serve.mode` must be "static" or "proxy"');
    return null;
}

function validateRequires(raw: unknown, errors: string[]): AppRequirementDecl[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        errors.push('`requires` must be an array when present');
        return undefined;
    }
    const out: AppRequirementDecl[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry) || !nonEmpty(entry.tool)) {
            errors.push(`\`requires[${i}].tool\` is required (the runtime or tool needed)`);
            return;
        }
        out.push({
            tool: entry.tool,
            ...(nonEmpty(entry.version) ? { version: entry.version } : {}),
            ...(nonEmpty(entry.reason) ? { reason: entry.reason } : {}),
        });
    });
    return out;
}


/**
 * Panels, defaulting to a single agent.
 *
 * An upper bound because this is a layout, not an appetite: a manifest asking for
 * ninety panels describes a window nobody can use, and accepting it would be
 * Genie's problem to render rather than the app's to justify.
 */
function validatePanels(raw: unknown, errors: string[]): AppPanels {
    if (raw === undefined) return { agents: 1 };
    if (!isRecord(raw)) {
        errors.push('`panels` must be an object when present');
        return { agents: 1 };
    }

    const agents = raw.agents ?? 1;
    if (
        typeof agents !== 'number' ||
        !Number.isInteger(agents) ||
        agents < 1 ||
        agents > MAX_AGENT_PANELS
    ) {
        errors.push(
            `\`panels.agents\` must be a whole number from 1 to ${MAX_AGENT_PANELS}`,
        );
        return { agents: 1 };
    }

    if (raw.kinds === undefined) return { agents };
    if (!Array.isArray(raw.kinds)) {
        errors.push('`panels.kinds` must be an array when present');
        return { agents };
    }
    const kinds: string[] = [];
    for (const kind of raw.kinds) {
        if (!nonEmpty(kind) || !APP_PANEL_KINDS.includes(kind)) {
            errors.push(`\`panels.kinds\` contains "${String(kind)}", which is not a Genie panel`);
            continue;
        }
        if (!kinds.includes(kind)) kinds.push(kind);
    }
    return { agents, ...(kinds.length > 0 ? { kinds } : {}) };
}

/**
 * A tab path must stay on the app's OWN origin.
 *
 * One leading slash, and the next character may NOT be another slash or a
 * backslash: `//example.com` is a PROTOCOL-RELATIVE url — it starts with `/`
 * and goes somewhere else entirely, which is exactly the bypass this stops.
 */
const APP_TAB_PATH = /^\/(?![/\\])\S*$/;

function validateTabs(raw: unknown, errors: string[]): AppTab[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        errors.push('`tabs` must be an array when present');
        return undefined;
    }
    if (raw.length > MAX_APP_TABS) {
        errors.push(
            `\`tabs\` declares ${raw.length} tabs; at most ${MAX_APP_TABS} fit beside Genie's own ` +
                'Agent and Flows tabs, and a strip that overflows pushes those out of the window.',
        );
        return undefined;
    }
    const out: AppTab[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry) || !nonEmpty(entry.title)) {
            errors.push(`\`tabs[${i}].title\` is required — the tab strip has to say something`);
            return;
        }
        // TRIMMED, like `name` is: the title is compared normalised, so padding
        // must not survive into the strip and render as the label it was compared
        // against.
        const title = entry.title.trim();
        // The strip is GENIE'S. An app labels its own surfaces in it; it does not
        // get to label them as Genie, as Genie's products, or as one of the tabs
        // Genie draws for itself immediately beside them.
        if (claimsReservedName(title) || claimsGenieTabTitle(title)) {
            errors.push(
                `\`tabs[${i}].title\` "${title}" is reserved — the tab strip is Genie's, and an ` +
                    'app may not label a tab as Genie, its first-party products, or one of ' +
                    "Genie's own tabs (Agent, Flows)",
            );
            return;
        }
        if (title.length > MAX_TAB_TITLE) {
            errors.push(
                `\`tabs[${i}].title\` is ${title.length} characters; at most ${MAX_TAB_TITLE}. ` +
                    "A label wide enough to fill the strip pushes Genie's own tabs out of the window.",
            );
            return;
        }
        if (!nonEmpty(entry.path) || !APP_TAB_PATH.test(entry.path)) {
            // A tab is Genie chrome wearing this app's name. An absolute URL would
            // put another origin inside that frame.
            errors.push(
                `\`tabs[${i}].path\` must be a path on the app's own site, starting with "/"`,
            );
            return;
        }
        out.push({ title, path: entry.path });
    });
    return out;
}

/**
 * A persona path, RELATIVE to `.agents/` and unable to leave it.
 *
 * This is the strict half of the pair, and it is strict for a concrete reason: the
 * persona is read and becomes an agent's instructions. A path that climbed out of
 * the folder would let a manifest point that at anything on the machine — an SSH
 * key, a `.env` — and have Genie hand it to a model. So: forward slashes only, and
 * each segment drawn from a small allow-list that cannot spell traversal.
 */
const PERSONA_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isPersonaPath(value: unknown): value is string {
    if (!nonEmpty(value)) return false;
    // An ALLOW-list, not a list of things to reject. A deny-list here would have to
    // enumerate every spelling of "leave the folder" — a Windows separator, a drive
    // letter, a leading slash, a URL — and the one that gets forgotten is the one
    // that gets used. Segments of `[A-Za-z0-9._-]` cannot express any of them.
    return value.split('/').every((seg) => PERSONA_SEGMENT.test(seg) && seg !== '.' && seg !== '..');
}

/**
 * The agents this app ships — every one of them named, and every one of them
 * pointed at a persona under `.agents/`.
 *
 * Absent stays ABSENT rather than becoming `[]`: most GApps ship no agent of their
 * own, and an empty roster would read as one that happens to be empty this time.
 */
function validateAgents(raw: unknown, errors: string[]): AppAgentDecl[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        errors.push('`agents` must be an array when present');
        return undefined;
    }
    if (raw.length > MAX_DECLARED_AGENTS) {
        errors.push(
            `\`agents\` declares ${raw.length} agents; at most ${MAX_DECLARED_AGENTS} can be ` +
                'put to the user at install, and a roster nobody reads is not consent.',
        );
        return undefined;
    }

    const out: AppAgentDecl[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, i) => {
        if (!isRecord(entry) || !nonEmpty(entry.name)) {
            errors.push(`\`agents[${i}].name\` is required — the consent screen has to name it`);
            return;
        }
        if (!isPersonaPath(entry.persona)) {
            errors.push(
                `\`agents[${i}].persona\` must be a path inside ${APP_AGENTS_DIR}/ — ` +
                    'relative, forward slashes, and it may not climb out of the folder',
            );
            return;
        }
        // Names are what the user reads. Two identical rows describe a roster they
        // cannot tell apart, which is the same as not being told.
        const key = entry.name.trim().toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) {
            errors.push(`\`agents[${i}].name\` "${entry.name.trim()}" is declared twice`);
            return;
        }
        seen.add(key);
        out.push({
            name: entry.name.trim(),
            persona: entry.persona,
            ...(nonEmpty(entry.description) ? { description: entry.description } : {}),
        });
    });
    return out;
}

function validateServices(raw: unknown, errors: string[]): AppService[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        errors.push('`services` must be an array when present');
        return undefined;
    }
    const out: AppService[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry)) {
            errors.push(`\`services[${i}]\` must be an object`);
            return;
        }
        if (!nonEmpty(entry.name)) errors.push(`\`services[${i}].name\` is required`);
        // LITERAL argv, never a shell string: a string here would be a command
        // injection surface the moment a manifest carried one.
        if (!Array.isArray(entry.command) || entry.command.length === 0) {
            errors.push(`\`services[${i}].command\` must be a non-empty argv ARRAY`);
            return;
        }
        if (!entry.command.every((a) => typeof a === 'string')) {
            errors.push(`\`services[${i}].command\` must contain only strings`);
            return;
        }
        if (!nonEmpty(entry.name)) return;
        out.push({
            name: entry.name,
            command: entry.command as string[],
            ...(nonEmpty(entry.repo) ? { repo: entry.repo } : {}),
            ...(typeof entry.port === 'number' ? { port: entry.port } : {}),
        });
    });
    return out;
}

/**
 * A tool slug, before it is namespaced. Mirrors the plugin rule so a developer who
 * has written one manifest does not have to learn a second spelling.
 */
const APP_TOOL_SLUG = /^[A-Za-z][A-Za-z0-9_]*$/;
/**
 * A tool roster is something the user has to READ at install and an agent has to
 * read on EVERY call — each one is a line on the consent screen and a descriptor
 * in `tools/list`. Same reasoning as the panel and agent caps.
 */
const MAX_APP_TOOLS = 24;

/**
 * Anything Genie does not recognise is refused, not dropped. See
 * {@link KNOWN_MANIFEST_KEYS} for why.
 */
function rejectUnknownKeys(
    raw: Record<string, unknown>,
    known: readonly string[],
    where: string,
    errors: string[],
): void {
    const unknown = Object.keys(raw).filter((key) => !known.includes(key));
    if (unknown.length === 0) return;
    errors.push(
        `${where} declares ${unknown.map((k) => `\`${k}\``).join(', ')}, which Genie does not ` +
            'know. A manifest is rebuilt from the fields Genie understands, so an unrecognised ' +
            'one would install cleanly and then not exist — this error is the point. Known ' +
            `fields: ${known.join(', ')}.`,
    );
}

function validateAppTools(raw: unknown, errors: string[]): AppMcpTool[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        errors.push(
            '`contributes.mcpTools` must be a non-empty array — `contributes` with no tools ' +
                'offers nothing',
        );
        return [];
    }
    if (raw.length > MAX_APP_TOOLS) {
        errors.push(
            `\`contributes.mcpTools\` offers ${raw.length} tools; at most ${MAX_APP_TOOLS}. Every ` +
                "one is a line on the consent screen and a descriptor in every caller's tool list.",
        );
        return [];
    }

    const out: AppMcpTool[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, i) => {
        const at = `\`contributes.mcpTools[${i}]\``;
        if (!isRecord(entry)) {
            errors.push(`${at} must be an object`);
            return;
        }
        if (!nonEmpty(entry.name)) {
            errors.push(`${at}.name is required`);
            return;
        }
        if (!APP_TOOL_SLUG.test(entry.name)) {
            errors.push(
                `${at}.name must start with a letter and use [A-Za-z0-9_] — it is namespaced as ` +
                    '`<slug>.<name>`, so a dot in it would be a second namespace',
            );
            return;
        }
        if (seen.has(entry.name)) {
            errors.push(`${at}.name "${entry.name}" is declared twice`);
            return;
        }
        seen.add(entry.name);
        if (!nonEmpty(entry.description)) {
            // Not decoration. It is the whole of what a calling agent has to go on
            // when deciding whether this tool is the one it wants.
            errors.push(`${at}.description is required — it is what a calling agent reads`);
            return;
        }
        if (!isRecord(entry.inputSchema) || entry.inputSchema.type !== 'object') {
            errors.push(`${at}.inputSchema is required and must be a JSON Schema with type:"object"`);
            return;
        }
        out.push({
            name: entry.name,
            description: entry.description,
            inputSchema: entry.inputSchema,
        });
    });
    return out;
}

function validateToolTransport(raw: unknown, errors: string[]): AppToolTransport | undefined {
    if (!isRecord(raw)) {
        errors.push(
            '`contributes.transport` is required — how Genie reaches the service: ' +
                '{ "kind": "stdio" } or { "kind": "http", "port": 8797 }',
        );
        return undefined;
    }
    if (raw.kind === 'stdio') return { kind: 'stdio' };
    if (raw.kind === 'http') {
        const port = raw.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            errors.push('`contributes.transport.port` must be a port number for an http transport');
            return undefined;
        }
        return { kind: 'http', port };
    }
    errors.push('`contributes.transport.kind` must be "stdio" or "http"');
    return undefined;
}

/**
 * The tools this app offers outward, and the service that runs them.
 *
 * Cross-checked against `services` on purpose: a `servedBy` naming nothing is a
 * manifest whose tools can never start, and finding that out at install beats
 * finding it out on a caller's first call — which is the exact failure mode this
 * whole block exists to end.
 */
function validateContributes(
    raw: unknown,
    services: AppService[] | undefined,
    errors: string[],
): AppContributes | undefined {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) {
        errors.push('`contributes` must be an object when present');
        return undefined;
    }
    rejectUnknownKeys(raw, KNOWN_CONTRIBUTES_KEYS, '`contributes`', errors);

    const mcpTools = validateAppTools(raw.mcpTools, errors);

    let servedBy: string | undefined;
    if (!nonEmpty(raw.servedBy)) {
        errors.push(
            '`contributes.servedBy` is required — name the entry in `services` that implements ' +
                'these tools',
        );
    } else if (!(services ?? []).some((s) => s.name === raw.servedBy)) {
        errors.push(
            `\`contributes.servedBy\` names "${raw.servedBy}", which is not a declared service. ` +
                'The tools are served by a process the APP owns — that is what buys them minutes ' +
                'of runtime and real OS authority — so it has to exist in `services`.',
        );
    } else {
        servedBy = raw.servedBy;
    }

    const transport = validateToolTransport(raw.transport, errors);

    if (mcpTools.length === 0 || !servedBy || !transport) return undefined;
    return { mcpTools, servedBy, transport };
}

/**
 * Who may call this app's tools — fail-closed, exactly like `scope`.
 *
 * `offersTools` is read from the RAW manifest rather than from the validated
 * `contributes`, so a `contributes` block that failed for its own reasons does not
 * also produce a misleading "you offer no tools" error beside the real one.
 */
function validateConsumers(
    raw: unknown,
    offersTools: boolean,
    errors: string[],
): AppConsumers | undefined {
    if (raw === undefined) {
        // An app that offers tools always HAS an answer to "who may call them",
        // and the absent answer is the narrowest one. An app that offers none has
        // no such question, so the field stays absent rather than becoming noise.
        return offersTools ? { scope: 'self' } : undefined;
    }
    if (!offersTools) {
        errors.push(
            '`permissions.consumers` says who may call this app’s tools, but the app offers ' +
                'none. Declare `contributes.mcpTools`, or drop `consumers` — a grant about ' +
                'nothing would put a sentence on the consent screen describing an offer the app ' +
                'cannot make.',
        );
        return undefined;
    }
    if (!isRecord(raw)) {
        errors.push('`permissions.consumers` must be an object when present');
        return { scope: 'self' };
    }
    rejectUnknownKeys(raw, KNOWN_CONSUMER_KEYS, '`permissions.consumers`', errors);

    const scope = raw.scope ?? 'self';
    if (scope !== 'self' && scope !== 'workspaces' && scope !== 'workstation') {
        errors.push(
            '`permissions.consumers.scope` must be "self", "workspaces" or "workstation"',
        );
        return { scope: 'self' };
    }
    if (scope === 'workspaces') {
        const list = raw.workspaces;
        // An empty allow-list must not read as "all" — the same rule as `scope`,
        // pointing the other way.
        if (!Array.isArray(list) || list.length === 0 || !list.every((w) => nonEmpty(w))) {
            errors.push(
                '`permissions.consumers.workspaces` must name at least one workspace when ' +
                    'consumers scope is "workspaces"',
            );
            return { scope: 'self' };
        }
        return { scope, workspaces: list as string[] };
    }
    return { scope };
}

/**
 * Permissions, defaulting to the NARROWEST scope.
 *
 * Absent must never read as "workstation": a GApp gets the least authority that
 * lets it exist until its manifest asks for more and the user agrees to it.
 */
function validatePermissions(
    raw: unknown,
    offersTools: boolean,
    errors: string[],
): AppPermissions {
    const withConsumers = (base: AppPermissions, consumers: AppConsumers | undefined) =>
        consumers ? { ...base, consumers } : base;

    if (raw === undefined) {
        return withConsumers(
            { scope: 'self', capabilities: [] },
            validateConsumers(undefined, offersTools, errors),
        );
    }
    if (!isRecord(raw)) {
        errors.push('`permissions` must be an object when present');
        return withConsumers(
            { scope: 'self', capabilities: [] },
            validateConsumers(undefined, offersTools, errors),
        );
    }
    rejectUnknownKeys(raw, KNOWN_PERMISSION_KEYS, '`permissions`', errors);

    const capabilities = validateCapabilities(raw.capabilities, errors);
    const consumers = validateConsumers(raw.consumers, offersTools, errors);

    const scope = raw.scope ?? 'self';
    if (scope !== 'self' && scope !== 'workspaces' && scope !== 'workstation') {
        errors.push('`permissions.scope` must be "self", "workspaces" or "workstation"');
        return withConsumers({ scope: 'self', capabilities }, consumers);
    }

    if (scope === 'workspaces') {
        const list = raw.workspaces;
        // An empty allow-list must not read as "all".
        if (!Array.isArray(list) || list.length === 0 || !list.every((w) => nonEmpty(w))) {
            errors.push(
                '`permissions.workspaces` must name at least one workspace when scope is "workspaces"',
            );
            return withConsumers({ scope: 'self', capabilities }, consumers);
        }
        return withConsumers({ scope, workspaces: list as string[], capabilities }, consumers);
    }

    return withConsumers({ scope, capabilities }, consumers);
}

/**
 * The declared capabilities — deduped, and every one of them real.
 *
 * An unknown name is an ERROR rather than something to drop: silently ignoring
 * `"root"` would let a manifest read as though it asked for something while the
 * runtime quietly granted nothing, and the developer would find out from a
 * mystery denial months later. Tool names are rejected for the same reason — they
 * would be a second, unclassified vocabulary inside the permission model.
 */
function validateCapabilities(raw: unknown, errors: string[]): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        errors.push('`permissions.capabilities` must be an array when present');
        return [];
    }
    const out: string[] = [];
    for (const entry of raw) {
        if (!nonEmpty(entry) || !isAppCapability(entry)) {
            errors.push(unknownCapabilityMessage(entry));
            continue;
        }
        if (!out.includes(entry)) out.push(entry);
    }
    return out;
}

/**
 * WHY a capability was refused, and what to write instead.
 *
 * The refusal alone is not enough. The SDK README lists capabilities and Genie's
 * MCP lists tools, so naming a TOOL here is the obvious mistake to make — and
 * "manageTerminals is not a Genie App capability" reads as "manageTerminals is off
 * limits", which is the opposite of true. Three different answers are owed, so
 * three are given: here is the capability that governs it, or nothing governs it
 * and here is why, or it is simply not a name Genie knows.
 */
function unknownCapabilityMessage(entry: unknown): string {
    const name = String(entry);
    const prefix = `\`permissions.capabilities\` contains "${name}", which is not a Genie App capability`;

    const ungrantable = UNGRANTABLE_TOOLS[name];
    if (ungrantable) {
        return (
            `${prefix} — it is a Genie TOOL, and one no app may use at any permission level. ` +
            `${ungrantable}`
        );
    }

    const governing = capabilityForTool(name);
    if (governing) {
        const capability = findCapability(governing);
        return (
            `${prefix} — it is a Genie TOOL. Ask for the capability that governs it instead: ` +
            `\`${governing}\`${capability ? ` (“${capability.label}”)` : ''}.`
        );
    }

    return `${prefix}. The capabilities are: ${APP_CAPABILITIES.map((c) => c.key).join(', ')}.`;
}

/**
 * Validate a `gapp.json`. Collects EVERY problem rather than stopping at the
 * first — an install that fails one reason at a time wastes the developer's day.
 */
export function validateAppManifest(raw: unknown): ValidationResult<AppManifest> {
    if (!isRecord(raw)) return { ok: false, errors: ['manifest must be a JSON object'] };

    const errors: string[] = [];

    rejectUnknownKeys(raw, KNOWN_MANIFEST_KEYS, 'The manifest', errors);

    if (!nonEmpty(raw.id)) errors.push('`id` is required (a non-empty string)');
    else if (!REVERSE_DNS.test(raw.id)) errors.push('`id` must be reverse-DNS (e.g. com.example.app)');

    if (!nonEmpty(raw.slug)) errors.push('`slug` is required');
    else if (!DNS_LABEL.test(raw.slug)) {
        // The slug is HOSTED — it becomes `<slug>.gen` — so anything that is not a
        // DNS label produces a site that cannot be served.
        errors.push('`slug` must be a lowercase DNS label ([a-z0-9-], max 63) — it becomes <slug>.gen');
    }

    if (!nonEmpty(raw.name)) errors.push('`name` is required');
    else if (claimsReservedName(raw.name)) {
        errors.push(
            `\`name\` "${raw.name.trim()}" is reserved — a GApp may not impersonate Genie or its first-party products`,
        );
    } else if (claimsGenieTabTitle(raw.name)) {
        // The name IS a tab label. `appWindowTabs` labels the single app tab with
        // `manifest.name` when no tabs are declared, so gating only `tabs[].title`
        // would leave the twin-tab attack open through the SIMPLER manifest —
        // declare nothing and be called "Flows".
        errors.push(
            `\`name\` "${raw.name.trim()}" is one of Genie's own tab labels — an app that ` +
                'declares no tabs is labelled by its name in that same strip, so it would ' +
                'render beside the real one',
        );
    } else if (raw.name.trim().length > MAX_APP_NAME) {
        errors.push(
            `\`name\` is ${raw.name.trim().length} characters; at most ${MAX_APP_NAME}. It is ` +
                "the window's grouping prefix and, for an app with no declared tabs, its tab label.",
        );
    }

    if (!nonEmpty(raw.version)) errors.push('`version` is required');
    else if (!SEMVER.test(raw.version)) errors.push('`version` must be semver (e.g. 1.0.0)');

    const requires = validateRequires(raw.requires, errors);
    const panels = validatePanels(raw.panels, errors);
    const tabs = validateTabs(raw.tabs, errors);
    const agents = validateAgents(raw.agents, errors);
    const frontend = validateFrontend(raw.frontend, errors);
    const services = validateServices(raw.services, errors);
    const contributes = validateContributes(raw.contributes, services, errors);
    // Read from the RAW block, so a `contributes` that failed its own validation
    // does not also make `consumers` look like a grant about nothing.
    const offersTools =
        isRecord(raw.contributes) &&
        Array.isArray(raw.contributes.mcpTools) &&
        raw.contributes.mcpTools.length > 0;
    const permissions = validatePermissions(raw.permissions, offersTools, errors);

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        value: {
            ...(nonEmpty(raw.$schema) ? { $schema: raw.$schema } : {}),
            id: raw.id as string,
            slug: raw.slug as string,
            name: (raw.name as string).trim(),
            version: raw.version as string,
            ...(nonEmpty(raw.description) ? { description: raw.description } : {}),
            frontend: frontend!,
            ...(services && services.length > 0 ? { services } : {}),
            ...(requires && requires.length > 0 ? { requires } : {}),
            panels,
            ...(tabs && tabs.length > 0 ? { tabs } : {}),
            ...(agents && agents.length > 0 ? { agents } : {}),
            ...(contributes ? { contributes } : {}),
            permissions,
        },
    };
}
