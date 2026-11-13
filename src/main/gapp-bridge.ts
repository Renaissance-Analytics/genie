import { randomBytes } from 'node:crypto';
import { APP_BRIDGE, type ElementDefinition } from '../core/catalog.js';
import { callDecision, type CatalogLookup, type GAppGrant } from '../core/gapp-grants.js';
import type { AgentId } from '../core/identity.js';
import { GAPP_STORAGE_QUOTA, GAppStore, storeKeyProblem } from './gapp-storage.js';
import type { GAppPreviews } from './gapp-previews.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';
import type { Caller, Registration } from './mcp-tools.js';

/**
 * THE BRIDGE (GApps v2, V5, Tynn #570; spec .ai/plans/specs/gapps-v2.md section 4). What an app's window can ask genie-host
 * over its channel (main/gapp-server.ts): who it is, a call to an element, its own store. Every answer is decided NOW from
 * the book and the catalog, so turning an app off, uninstalling it or taking something back counts from its next call; a
 * call already running finishes (A6's rule).
 *
 * `app.call`: the grant is checked (V2's callDecision), then the element runs as Genie runs it: a tool's own handler,
 * with the app as the caller, so every rule that tool applies to an agent applies to the app.
 *
 * `app.me` and both events also carry `granted`, what the app can call now: the bridge is fixed (APP_BRIDGE), and it is the
 * only thing `can()` in the app-sdk (V6) has to read.
 */
export interface GAppIdentity { readonly packageId: string; readonly preview: boolean }
export type BridgeAnswer = { result: unknown } | { error: string; notGranted?: string };
export type GAppRun = (def: ElementDefinition, args: Record<string, unknown>, app: { packageId: string; name: string }, workspaceId: string) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
export type BridgeEvent = (typeof APP_BRIDGE.events)[number];

export interface GAppBridgePorts {
    readonly book: Pick<GAppBook, 'list' | 'appElement' | 'storageDir' | 'onChange'>;
    /** A workspace's previews (V8): a preview's window answers for the preview, never the installed app. */
    readonly previews?: Pick<GAppPreviews, 'entry' | 'appElement'>;
    /** Genie's catalog as it is now. */
    readonly catalog: CatalogLookup;
    readonly run: GAppRun;
    readonly onCatalogChange: (listener: (revision: number) => void) => () => void;
    readonly quotaBytes?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class GAppBridge {
    readonly #ports: GAppBridgePorts;
    readonly #stores = new Map<string, GAppStore>();
    readonly #listeners = new Set<(packageId: string, event: BridgeEvent, data: unknown) => void>();
    readonly #off: Array<() => void>;
    #grantsHeard: Map<string, string>;

    constructor(ports: GAppBridgePorts) {
        this.#ports = ports;
        this.#grantsHeard = this.#grantKeys();
        this.#off = [
            ports.book.onChange(() => this.#bookChanged()),
            ports.onCatalogChange((revision) => this.#catalogChanged(revision)),
        ];
    }

    close(): void {
        for (const off of this.#off.splice(0)) off();
    }

    onEvent(listener: (packageId: string, event: BridgeEvent, data: unknown) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** One call from one app's window. `app` is who the channel's token says it is, never anything the call says. */
    async handle(app: GAppIdentity, method: string, params?: unknown): Promise<BridgeAnswer> {
        if (!(APP_BRIDGE.calls as readonly string[]).includes(method)) return { error: `${method} is not part of the app bridge` };
        const found = this.#entryOf(app);
        if ('error' in found) return found;
        const { entry } = found;
        const input = isRecord(params) ? params : {};
        try {
            if (method === 'app.me') return { result: this.#me(entry, app.preview) };
            if (method === 'app.call') return await this.#call(entry, input);
            return await this.#storage(entry, app.preview, method, input);
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** The record a window answers by: the installed app's, or its workspace's preview's, as each is now. */
    #entryOf(app: GAppIdentity): { entry: GAppEntry } | { error: string } {
        if (app.preview) {
            const p = this.#ports.previews?.entry(app.packageId) ?? null;
            if (!p || !p.grant) return { error: `the preview of ${app.packageId} is not open in any workspace` };
            return { entry: { packageId: p.packageId, name: p.name, version: p.version, digest: p.digest, state: 'installed', unverified: p.unverified, grant: p.grant } };
        }
        const entry = this.#ports.book.list().find((e) => e.packageId === app.packageId);
        if (!entry) return { error: `${app.packageId} is no longer installed` };
        if (entry.state !== 'installed') return { error: `${entry.name} is turned off` };
        return { entry };
    }

    #me(entry: GAppEntry, preview: boolean): unknown {
        const { grant } = entry;
        return { packageId: entry.packageId, version: entry.version, preview, scope: grant.scope, publisher: grant.publisher, granted: this.#granted(entry) };
    }

    async #call(entry: GAppEntry, input: Record<string, unknown>): Promise<BridgeAnswer> {
        const elementId = input.elementId;
        if (typeof elementId !== 'string' || elementId === '') return { error: 'app.call needs an elementId: the element to call' };
        if (input.args !== undefined && !isRecord(input.args)) return { error: 'app.call takes its args as an object' };
        const named = typeof input.workspaceId === 'string' ? input.workspaceId : null;
        const { grant } = entry;
        // A grant of exactly one workspace can only mean that one.
        const workspaceId = named ?? (grant.scope !== 'workstation' && grant.scope.length === 1 ? grant.scope[0]! : null);
        const decision = callDecision(grant, { elementId, workspaceId }, this.#ports.catalog);
        if (!decision.allowed) return { error: decision.reason, ...(decision.notGranted ? { notGranted: decision.notGranted } : {}) };
        const def = this.#ports.catalog(elementId)!;
        if (def.kind !== 'tool') return { error: `"${elementId}" is a ${def.kind}: only a tool can be called` };
        if (workspaceId === null) return { error: `say which workspace "${elementId}" should act in: ${entry.name} is granted the whole workstation` };
        const ran = await this.#ports.run(def, input.args ?? {}, { packageId: entry.packageId, name: entry.name }, workspaceId);
        return ran.ok ? { result: ran.result } : { error: ran.error };
    }

    async #storage(entry: GAppEntry, preview: boolean, method: string, input: Record<string, unknown>): Promise<BridgeAnswer> {
        const element = preview ? this.#ports.previews?.appElement(entry.packageId) : this.#ports.book.appElement(entry.packageId);
        if (element?.payload.storage === 'none') return { error: `${entry.name} keeps no data: it declares storage "none"` };
        const store = this.#storeOf(entry, preview);
        if (method === 'app.storage.list') return { result: await store.list(typeof input.prefix === 'string' ? input.prefix : '') };
        const problem = storeKeyProblem(input.key);
        if (problem) return { error: problem };
        const key = input.key as string;
        if (method === 'app.storage.get') return { result: await store.get(key) };
        if (method === 'app.storage.delete') return { result: await store.delete(key) };
        if (input.value === undefined) return { error: 'app.storage.set needs a value' };
        const saved = await store.set(key, input.value);
        return saved.ok ? { result: true } : { error: saved.reason };
    }

    #storeOf(entry: GAppEntry, preview: boolean): GAppStore {
        const dir = this.#ports.book.storageDir(entry.packageId, preview);
        let store = this.#stores.get(dir);
        if (!store) {
            store = new GAppStore({ dir, name: entry.name, quotaBytes: this.#ports.quotaBytes ?? GAPP_STORAGE_QUOTA });
            this.#stores.set(dir, store);
        }
        return store;
    }

    /** What this app can call now: granted, still in Genie, still grantable. */
    #granted(entry: GAppEntry): string[] {
        if (entry.state !== 'installed') return [];
        const { grant } = entry;
        const workspaceId = grant.scope === 'workstation' ? null : (grant.scope[0] ?? null);
        return grant.uses.filter((elementId) => callDecision(grant, { elementId, workspaceId }, this.#ports.catalog).allowed);
    }

    #grantKeys(): Map<string, string> {
        return new Map(this.#ports.book.list().map((e) => [e.packageId, grantKey(e.grant, e.state)]));
    }

    #bookChanged(): void {
        const before = this.#grantsHeard;
        this.#grantsHeard = this.#grantKeys();
        const entries = this.#ports.book.list();
        for (const [packageId, key] of this.#grantsHeard) {
            if (before.get(packageId) === key || !before.has(packageId)) continue;
            const entry = entries.find((e) => e.packageId === packageId)!;
            this.#emit(packageId, 'app.grantChanged', { granted: this.#granted(entry), scope: entry.grant.scope });
        }
    }

    #catalogChanged(revision: number): void {
        for (const entry of this.#ports.book.list()) this.#emit(entry.packageId, 'app.catalogChanged', { revision, granted: this.#granted(entry) });
    }

    #emit(packageId: string, event: BridgeEvent, data: unknown): void {
        for (const listener of [...this.#listeners]) listener(packageId, event, data);
    }
}

function grantKey(grant: GAppGrant, state: GAppEntry['state']): string {
    return JSON.stringify([state, grant.uses, grant.network, grant.scope, grant.version, grant.publisher]);
}

/**
 * THE APP AS A CALLER of Genie's tools, as a flow is one (main/flow-tools.ts): a session key per app and workspace,
 * resolving to the app, by its own name, in that workspace. A key this did not mint is nobody.
 */
export class GAppCallers {
    readonly #workspacePath: (workspaceId: string) => string | null;
    readonly #byKey = new Map<string, { packageId: string; name: string; workspaceId: string }>();
    readonly #keyOf = new Map<string, string>();

    constructor(workspacePath: (workspaceId: string) => string | null) {
        this.#workspacePath = workspacePath;
    }

    keyFor(app: { packageId: string; name: string }, workspaceId: string): string {
        const of = JSON.stringify([app.packageId, workspaceId]);
        const key = this.#keyOf.get(of) ?? `gapp-session-${randomBytes(16).toString('hex')}`;
        this.#keyOf.set(of, key);
        this.#byKey.set(key, { packageId: app.packageId, name: app.name, workspaceId });
        return key;
    }

    callerFor(key: string): Caller | null {
        const found = this.#byKey.get(key);
        if (!found) return null;
        const workspacePath = this.#workspacePath(found.workspaceId);
        if (workspacePath === null) return null;
        return { agentId: `gapp:${found.packageId}` as AgentId, agentName: `app "${found.name}"`, workspaceId: found.workspaceId, workspacePath, kind: 'app' };
    }
}

/** An element's run: the tool's real handler, found at the call (A6: never an old one), as the app. */
export function createGAppToolRunner(deps: { registrations: () => readonly Registration[]; callers: GAppCallers }): GAppRun {
    return async (def, args, app, workspaceId) => {
        const name = String(def.payload.handler);
        const key = deps.callers.keyFor(app, workspaceId);
        if (deps.callers.callerFor(key) === null) return { ok: false, error: `Genie has no workspace ${workspaceId} here; "${def.id}" was not called` };
        const headers = { 'genie-session': key };
        const registration = deps.registrations().find((r) => r.definition.name === name);
        if (!registration || (registration.visible && !(await registration.visible({ headers })))) return { ok: false, error: `"${def.id}" is unavailable to ${app.name} right now` };
        const { terminalId: _never, ...rest } = args;
        try {
            const answer = await registration.handler(rest as never, { server: 'genie', tool: name, headers } as never);
            let parsed: unknown = answer.text;
            try { parsed = JSON.parse(answer.text); } catch { /* plain text */ }
            if (!answer.isError) return { ok: true, result: parsed };
            return { ok: false, error: isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : answer.text };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };
}
