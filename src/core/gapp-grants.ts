import type { ElementDefinition } from './catalog.js';

/**
 * THE GRANT MODEL (GApps v2, V2, Tynn #567; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08) — pure. A GRANT is the
 * host's record of what the person allowed one installed app: the app's manifest ASKS (its `app` element's `uses` and its
 * network hosts), the grant ANSWERS. The host decides at install, at each update, and at each call, from here.
 *
 * What a person reads is Genie's, never the app's: each element is named and described as the CATALOG has it.
 */

/** What an app asks for, from its `app` element and its package's check (B4/B5). */
export interface GAppRequest {
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
    /** The signing key's id, or `unverified` (publisher checks off, B5). */
    readonly publisher: string;
    readonly uses: readonly string[];
    readonly network: readonly string[];
}

export type GrantScope = 'workstation' | readonly string[];

export interface GAppGrant {
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
    readonly publisher: string;
    readonly uses: readonly string[];
    readonly network: readonly string[];
    /** Where it may act: the whole workstation, or these workspaces only. */
    readonly scope: GrantScope;
    readonly grantedAt: number;
    readonly grantedBy: 'person';
}

export type ReviewItem =
    | { readonly kind: 'element'; readonly id: string; readonly name: string; readonly description: string }
    | { readonly kind: 'network'; readonly host: string }
    | { readonly kind: 'publisher'; readonly from: string; readonly to: string };

/** A catalog lookup by id: `null` when Genie has no such element. */
export type CatalogLookup = (id: string) => ElementDefinition | null;

/**
 * Genie's own tools a GApp is NEVER granted (decision 3): the ones that act as the person (their question, their handoff,
 * a new agent, their workspace's tabs, mail as them, their lists: items there put work in front of the person, the
 * coordinator's ruling of 2026-11-08, starting conservative), and the ones that wait on the person's approval (a
 * terminal, a service, a site, a background process, a page). `grantable: false` in Genie's catalog (main/genie-catalog.ts).
 */
export const PERSON_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'ForceTheQuestion', 'imDone', 'createAgent', 'workspaceTabs', 'agentinbox', 'lists',
    'manageTerminals', 'services', 'sites', 'processes', 'pages',
]);

/** Why an app may never be granted this element, or null: `grantable: false`, or gated by the person's approval. */
function ungrantable(def: ElementDefinition): string | null {
    if (def.payload.grantable === false) return `"${def.id}" (${def.docs.name}) is never granted to an app: only the person may do it`;
    if (def.payload.gated === true) return `"${def.id}" (${def.docs.name}) is never granted to an app: it waits on the person's approval`;
    return null;
}

function elementItems(ids: readonly string[], catalog: CatalogLookup): { items: ReviewItem[]; problems: string[] } {
    const items: ReviewItem[] = [];
    const problems: string[] = [];
    for (const id of ids) {
        const def = catalog(id);
        if (!def) { problems.push(`"${id}" is not in Genie: the app uses something Genie does not have`); continue; }
        const why = ungrantable(def);
        if (why) { problems.push(why); continue; }
        items.push({ kind: 'element', id, name: def.docs.name, description: def.docs.description });
    }
    return { items, problems };
}

/** What the person reads before installing, or why the app cannot be installed at all. */
export function installReview(request: GAppRequest, catalog: CatalogLookup): { ok: true; publisher: string; items: ReviewItem[] } | { ok: false; problems: string[] } {
    const { items, problems } = elementItems(request.uses, catalog);
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, publisher: request.publisher, items: [...items, ...request.network.map((host): ReviewItem => ({ kind: 'network', host }))] };
}

/**
 * An update against the grant: consent again only for what is NEW (an element, a host, a publisher). Asking for nothing
 * new, or for less, installs straight away. An update that now asks for something ungrantable is refused.
 */
export function updateReview(grant: GAppGrant, request: GAppRequest, catalog: CatalogLookup): { ok: true; consent: false } | { ok: true; consent: true; items: ReviewItem[] } | { ok: false; problems: string[] } {
    const all = elementItems(request.uses, catalog);
    if (all.problems.length > 0) return { ok: false, problems: all.problems };
    const items: ReviewItem[] = [
        ...(request.publisher !== grant.publisher ? [{ kind: 'publisher' as const, from: grant.publisher, to: request.publisher }] : []),
        ...all.items.filter((i) => i.kind === 'element' && !grant.uses.includes(i.id)),
        ...request.network.filter((h) => !grant.network.includes(h)).map((host): ReviewItem => ({ kind: 'network', host })),
    ];
    return items.length === 0 ? { ok: true, consent: false } : { ok: true, consent: true, items };
}

/** The record the person's consent writes: what was asked, where it may act, when, by whom. */
export function grantFor(request: GAppRequest, options: { scope: GrantScope; now: number }): GAppGrant {
    return {
        packageId: request.packageId, version: request.version, digest: request.digest, publisher: request.publisher,
        uses: [...request.uses], network: [...request.network], scope: options.scope === 'workstation' ? 'workstation' : [...options.scope],
        grantedAt: options.now, grantedBy: 'person',
    };
}

/** At each call from the app: granted, still in Genie, still grantable, inside the scope; otherwise refused by name. */
export function callDecision(grant: GAppGrant, call: { elementId: string; workspaceId: string | null }, catalog: CatalogLookup): { allowed: true } | { allowed: false; reason: string; notGranted?: string } {
    if (!grant.uses.includes(call.elementId)) return { allowed: false, notGranted: call.elementId, reason: `${grant.packageId} was not granted "${call.elementId}"` };
    const def = catalog(call.elementId);
    if (!def) return { allowed: false, reason: `"${call.elementId}" is no longer in Genie` };
    const why = ungrantable(def);
    if (why) return { allowed: false, reason: why };
    if (grant.scope !== 'workstation') {
        if (call.workspaceId === null || !grant.scope.includes(call.workspaceId)) {
            return { allowed: false, reason: `${call.workspaceId ?? 'the workstation'} is outside ${grant.packageId}'s grant: it may act in ${grant.scope.join(', ')} only` };
        }
    }
    return { allowed: true };
}
