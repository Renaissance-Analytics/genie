/**
 * The shapes a Genie App is written against (Tynn #250).
 *
 * Two halves. {@link GenieAppManifest} is what you AUTHOR — `genie-app.json`, the
 * declaration Genie validates at install and turns into a consent prompt.
 * {@link GenieAppHost} is what Genie EXPOSES to your page at runtime, and it is
 * deliberately two calls wide.
 */

/** Which workspaces an app may act on. */
export type GenieAppScope = 'self' | 'workspaces' | 'workstation';

/**
 * The capabilities an app can ask for. Each maps to a set of Genie tools, and each
 * is one line on the consent screen the user sees at install.
 */
export type GenieAppCapability =
    /** Open terminals and run any command on this machine, as the user. */
    | 'terminals'
    /** Start and steer autonomous coding agents. */
    | 'agents'
    /** Supervised background processes and cron jobs. */
    | 'processes'
    /** Read and write workspace environment variables (API keys, tokens). */
    | 'secrets'
    /** Serve sites at `.gen` addresses; run databases and caches. */
    | 'hosting'
    /** List, open and create workspaces, within the granted scope. */
    | 'workspaces'
    /** Read and write Genie's knowledge graph. */
    | 'knowledge'
    /** The open issues, PRs and security alerts Genie tracks. */
    | 'issues'
    /** Surface a file in Genie's editor for the user to look at. */
    | 'files'
    /** Signal completion and message the user through the Agent Inbox. */
    | 'notify'
    /** Raise an always-on-top question and wait for an answer. */
    | 'ask';

/** How an app's front end is served. */
export type GenieAppServe =
    /** A built directory Genie serves (`dist`, `build`, `out`). */
    | { mode: 'static'; root: string; spa?: boolean }
    /** A dev server YOU already run; Genie fronts the port. */
    | { mode: 'proxy'; hostPort: number };

export interface GenieAppManifest {
    /** Reverse-DNS and globally unique — `com.yourname.yourapp`. */
    id: string;
    /** A DNS label. It becomes `<slug>.gen`, so it must be servable. */
    slug: string;
    /** Shown everywhere. May not claim to be Genie or a first-party product. */
    name: string;
    version: string;
    description?: string;
    frontend: {
        repo?: string;
        serve: GenieAppServe;
        /** Reachable from a real browser, not only the Genie window. */
        browserExposed?: boolean;
    };
    /** Backends to run beside the front end. Any language. */
    services?: Array<{
        name: string;
        repo?: string;
        /** LITERAL argv, never a shell string. */
        command: string[];
        port?: number;
    }>;
    /** Runtimes the app needs. Genie installs what it can and shows the rest. */
    requires?: Array<{ tool: string; version?: string; reason?: string }>;
    permissions: {
        scope: GenieAppScope;
        /** Required when scope is `workspaces`. */
        workspaces?: string[];
        /** Ask for the least that lets the app work. */
        capabilities: GenieAppCapability[];
    };
}

/** Who the app is, and what the USER granted it — not what it asked for. */
export interface GenieAppIdentity {
    id: string;
    name: string;
    workspaceId: string;
    scope: GenieAppScope;
    capabilities: string[];
}

export interface GenieAppCallResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

/**
 * What Genie exposes on `window.genieApp`.
 *
 * Two calls. There is no app id on either — identity is the WINDOW Genie gave you,
 * which is why a page cannot claim to be a different app.
 */
export interface GenieAppHost {
    me: () => Promise<GenieAppIdentity | null>;
    call: (
        tool: string,
        args?: Record<string, unknown>,
        workspaceId?: string,
    ) => Promise<GenieAppCallResult>;
}
