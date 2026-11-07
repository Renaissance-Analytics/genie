import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSourceKind } from '../core/app-inbox.js';
import type { AgentRecord } from '../core/identity.js';
import { AppInboxKeys, type ScriptKeyView } from './app-inbox-keys.js';
import { APP_INBOX_PORT, AppInboxService, appInboxEnvFor, startAppInboxServer, type AppEnvSource, type AppInboxServer } from './app-inbox-service.js';
import type { InboxStore } from './inbox-store.js';

/**
 * THE APP DOOR, GENIE-HOST'S (the host split, P5a.2, ruling 3). The door (app-inbox-service.ts) and its keys
 * (app-inbox-keys.ts) run in the host — one writer of app-inbox.json — so every site's and kept process's credential is
 * minted here, with or without a window, and the door that accepts it is up as long as the host is. A window reads the
 * keys' state through `AppInboxReplica` and asks for every change.
 *
 * THE SECRET RULE: a token travels ONCE — in the answer to the call that created it (a window's createScriptKey) or in the
 * env of the source it was minted for. Never in the dump, an event, or a log line: the dump carries names, ids and dates.
 * The keys keep only hashes on disk (as in a window-era Genie, whose app-inbox.json this reads as it is).
 */

/** What a window reads: per workspace, the sources holding a live token, the revoked ones, the script keys. NO secret. */
export interface AppInboxDump {
    readonly url: string | null;
    readonly workspaces: Readonly<Record<string, {
        readonly sources: ReadonlyArray<{ kind: AppSourceKind; id: string; name: string }>;
        readonly revoked: ReadonlyArray<{ kind: AppSourceKind; id: string; name?: string }>;
        readonly scriptKeys: readonly ScriptKeyView[];
    }>>;
}

export type AppInboxEvent = { readonly kind: 'dump'; readonly dump: AppInboxDump };

export interface AppInboxHostDeps {
    readonly home: string;
    readonly inbox: Pick<InboxStore, 'send' | 'unread' | 'all'>;
    readonly roster: () => readonly AgentRecord[];
    readonly slugs?: () => ReadonlyMap<string, string>;
    readonly defaultAgentOf?: (workspaceId: string) => string | null;
    readonly refusalForRecipient?: (address: string, workspaceId: string) => string | null;
    /** The workspace's "Apps and scripts may message agents here" (`app_inbox`, on by default). */
    readonly enabled: (workspaceId: string) => boolean;
    readonly siteHosts: (workspaceId: string) => readonly string[];
    /** The registered workspaces' ids: each one's keys are in the dump. */
    readonly workspaces: () => readonly string[];
    /** The port tried first; the remembered one (app-inbox-endpoint.json) or APP_INBOX_PORT by default; 0 = any. */
    readonly port?: number;
    readonly log?: (line: string) => void;
}

const ENDPOINT_FILE = 'app-inbox-endpoint.json';

export class AppInboxHost {
    readonly #keys: AppInboxKeys;
    readonly #server: AppInboxServer | null;
    readonly #deps: AppInboxHostDeps;
    readonly #listeners = new Set<(event: AppInboxEvent) => void>();
    #last = '';

    private constructor(keys: AppInboxKeys, server: AppInboxServer | null, deps: AppInboxHostDeps) {
        this.#keys = keys;
        this.#server = server;
        this.#deps = deps;
    }

    static async start(deps: AppInboxHostDeps): Promise<AppInboxHost> {
        const log = deps.log ?? (() => {});
        const keys = await AppInboxKeys.open(deps.home);
        let host: AppInboxHost | null = null;
        const service = new AppInboxService({
            // A script key's "last used" is a change the windows see (its date, never its secret).
            keys: { resolve: (token) => keys.resolve(token), used: async (source) => { await keys.used(source); host?.changed(); } },
            inbox: deps.inbox,
            roster: deps.roster,
            ...(deps.slugs ? { slugs: deps.slugs } : {}),
            ...(deps.defaultAgentOf ? { defaultAgentOf: deps.defaultAgentOf } : {}),
            ...(deps.refusalForRecipient ? { refusalForRecipient: deps.refusalForRecipient } : {}),
            enabled: deps.enabled,
            siteHosts: deps.siteHosts,
            log,
        });
        const endpointFile = join(deps.home, ENDPOINT_FILE);
        let remembered: number | undefined;
        try { const v = JSON.parse(readFileSync(endpointFile, 'utf8')) as { port?: unknown }; if (typeof v.port === 'number') remembered = v.port; } catch { remembered = undefined; }
        let server: AppInboxServer | null = null;
        try {
            server = await startAppInboxServer({ service, port: deps.port ?? remembered ?? APP_INBOX_PORT });
            if (deps.port === undefined && server.port !== remembered) writeFileSync(endpointFile, JSON.stringify({ url: server.url, port: server.port }), { mode: 0o600 });
            log(`[app-inbox] apps and scripts post to ${server.url}`);
        } catch (error) {
            log(`[app-inbox] the door for apps could not listen: ${error instanceof Error ? error.message : String(error)}`);
        }
        host = new AppInboxHost(keys, server, deps);
        return host;
    }

    /** The door's loopback URL; null when it could not listen. */
    get url(): string | null {
        return this.#server?.url ?? null;
    }

    /** A site's or kept process's OWN credential — minted here, with or without a window; none while its workspace's switch is off or it is revoked. */
    envFor(source: AppEnvSource): Record<string, string> {
        if (!this.#deps.enabled(source.workspaceId)) return {};
        const before = this.#keys.sources(source.workspaceId).length;
        const env = appInboxEnvFor({ url: this.url, token: this.#keys.tokenFor(source) });
        if (this.#keys.sources(source.workspaceId).length !== before) this.changed();
        return env;
    }

    dump(): AppInboxDump {
        const ids = this.#deps.workspaces();
        return {
            url: this.url,
            workspaces: Object.fromEntries(ids.map((id) => [id, { sources: this.#keys.sources(id), revoked: this.#keys.revokedSources(id), scriptKeys: this.#keys.scriptKeys(id) }])),
        };
    }

    onEvent(listener: (event: AppInboxEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A window's change. createScriptKey answers the secret — to that call only — and the dump that follows has none. */
    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const k = this.#keys;
        const s = (i: number): string => String(args[i]);
        let value: unknown;
        switch (method) {
            case 'createScriptKey': value = await k.createScriptKey(s(0), s(1)); break;
            case 'revokeScriptKey': value = await k.revokeScriptKey(s(0)); break;
            case 'rotate': k.rotate(s(0) as AppSourceKind, s(1)); value = true; break;
            case 'revokeSource': value = await k.revokeSource(args[0] as Parameters<AppInboxKeys['revokeSource']>[0]); break;
            case 'allowSource': value = await k.allowSource(s(0) as AppSourceKind, s(1)); break;
            default: throw new Error(`a window cannot call appInbox.${method}`);
        }
        this.changed();
        return value ?? null;
    }

    /** The keys' state changed: every window is sent the new dump (no secret in it). */
    changed(): void {
        const dump = this.dump();
        const text = JSON.stringify(dump);
        if (text === this.#last) return;
        this.#last = text;
        for (const l of [...this.#listeners]) { try { l({ kind: 'dump', dump }); } catch { /* one window never costs another */ } }
    }

    async close(): Promise<void> {
        await this.#server?.close();
    }
}

/**
 * THE HOST'S APP DOOR, AS A WINDOW READS AND DRIVES IT (P5a.2). Reads from the last dump; every change is the host's.
 * `rotate` is used synchronously by the window, so it answers at once and the host's dump follows.
 */
export class AppInboxReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    #dump: AppInboxDump | null = null;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    rebase(dump: AppInboxDump): void { this.#dump = dump; }
    apply(event: AppInboxEvent): void { this.rebase(event.dump); }

    url(): string | null { return this.#dump?.url ?? null; }
    sources(workspaceId: string): Array<{ kind: AppSourceKind; id: string; name: string }> { return [...(this.#dump?.workspaces[workspaceId]?.sources ?? [])]; }
    revokedSources(workspaceId: string): Array<{ kind: AppSourceKind; id: string; name?: string }> { return [...(this.#dump?.workspaces[workspaceId]?.revoked ?? [])]; }
    scriptKeys(workspaceId: string): ScriptKeyView[] { return [...(this.#dump?.workspaces[workspaceId]?.scriptKeys ?? [])]; }

    async createScriptKey(workspaceId: string, name: string): Promise<{ id: string; token: string }> {
        return (await this.#call('createScriptKey', [workspaceId, name])) as { id: string; token: string };
    }
    async revokeScriptKey(id: string): Promise<boolean> { return (await this.#call('revokeScriptKey', [id])) === true; }
    rotate(kind: AppSourceKind, id: string): void { void this.#call('rotate', [kind, id]).catch(() => {}); }
    async revokeSource(source: { readonly kind: AppSourceKind; readonly id: string; readonly workspaceId: string; readonly name?: string }): Promise<void> { await this.#call('revokeSource', [source]); }
    async allowSource(kind: AppSourceKind, id: string): Promise<void> { await this.#call('allowSource', [kind, id]); }
}
