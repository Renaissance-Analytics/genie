/**
 * PURE. The GApp manifest (`genie-app.json`) — what a Genie App IS, and what it
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

export const APP_MANIFEST_FILENAME = 'genie-app.json';

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
    permissions: AppPermissions;
}

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Reserved-name comparison, immune to casing and padding. */
function claimsReservedName(name: string): boolean {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return RESERVED_APP_NAMES.includes(normalized);
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
    const out: AppTab[] = [];
    raw.forEach((entry, i) => {
        if (!isRecord(entry) || !nonEmpty(entry.title)) {
            errors.push(`\`tabs[${i}].title\` is required — the tab strip has to say something`);
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
        out.push({ title: entry.title, path: entry.path });
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
 * Permissions, defaulting to the NARROWEST scope.
 *
 * Absent must never read as "workstation": a GApp gets the least authority that
 * lets it exist until its manifest asks for more and the user agrees to it.
 */
function validatePermissions(raw: unknown, errors: string[]): AppPermissions {
    if (raw === undefined) return { scope: 'self', capabilities: [] };
    if (!isRecord(raw)) {
        errors.push('`permissions` must be an object when present');
        return { scope: 'self', capabilities: [] };
    }

    const capabilities = validateCapabilities(raw.capabilities, errors);

    const scope = raw.scope ?? 'self';
    if (scope !== 'self' && scope !== 'workspaces' && scope !== 'workstation') {
        errors.push('`permissions.scope` must be "self", "workspaces" or "workstation"');
        return { scope: 'self', capabilities };
    }

    if (scope === 'workspaces') {
        const list = raw.workspaces;
        // An empty allow-list must not read as "all".
        if (!Array.isArray(list) || list.length === 0 || !list.every((w) => nonEmpty(w))) {
            errors.push(
                '`permissions.workspaces` must name at least one workspace when scope is "workspaces"',
            );
            return { scope: 'self', capabilities };
        }
        return { scope, workspaces: list as string[], capabilities };
    }

    return { scope, capabilities };
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
 * Validate a `genie-app.json`. Collects EVERY problem rather than stopping at the
 * first — an install that fails one reason at a time wastes the developer's day.
 */
export function validateAppManifest(raw: unknown): ValidationResult<AppManifest> {
    if (!isRecord(raw)) return { ok: false, errors: ['manifest must be a JSON object'] };

    const errors: string[] = [];

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
    }

    if (!nonEmpty(raw.version)) errors.push('`version` is required');
    else if (!SEMVER.test(raw.version)) errors.push('`version` must be semver (e.g. 1.0.0)');

    const requires = validateRequires(raw.requires, errors);
    const panels = validatePanels(raw.panels, errors);
    const tabs = validateTabs(raw.tabs, errors);
    const agents = validateAgents(raw.agents, errors);
    const frontend = validateFrontend(raw.frontend, errors);
    const services = validateServices(raw.services, errors);
    const permissions = validatePermissions(raw.permissions, errors);

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        value: {
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
            permissions,
        },
    };
}
