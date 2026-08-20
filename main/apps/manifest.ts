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
    permissions: AppPermissions;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const REVERSE_DNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
/** A DNS label: what can legally become `<slug>.gen`. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

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
    if (raw === undefined) return { scope: 'self' };
    if (!isRecord(raw)) {
        errors.push('`permissions` must be an object when present');
        return { scope: 'self' };
    }

    const scope = raw.scope ?? 'self';
    if (scope !== 'self' && scope !== 'workspaces' && scope !== 'workstation') {
        errors.push('`permissions.scope` must be "self", "workspaces" or "workstation"');
        return { scope: 'self' };
    }

    if (scope === 'workspaces') {
        const list = raw.workspaces;
        // An empty allow-list must not read as "all".
        if (!Array.isArray(list) || list.length === 0 || !list.every((w) => nonEmpty(w))) {
            errors.push(
                '`permissions.workspaces` must name at least one workspace when scope is "workspaces"',
            );
            return { scope: 'self' };
        }
        return { scope, workspaces: list as string[] };
    }

    return { scope };
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
            permissions,
        },
    };
}
