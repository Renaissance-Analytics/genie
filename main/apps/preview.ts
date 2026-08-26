/**
 * PURE. What a GApp PREVIEW is, and what it may never be (Tynn #250).
 *
 * The developer loop had a hole in the middle. A GApp folder could be scaffolded,
 * checked, and installed — and there was no way to SEE the app in the window its
 * users will get without installing it first. So the loop's fast half was the one
 * that told you least: a check says the manifest is coherent, an install tells you
 * what it looks like, and only the second one is the question anybody is actually
 * asking.
 *
 * A previewer only earns its place if it opens the REAL window: the real strip,
 * the real Agent tab with the panels the manifest declared, the real embedded
 * views under the real isolation. One that rendered a lookalike would be worse
 * than none, because it would show a developer something their users will not get
 * and give them no reason to doubt it.
 *
 * That leaves exactly one thing a preview must differ in, and this module is it:
 *
 * **A preview is not the app.** It runs beside a possible installed copy of the
 * same app, on the same machine, at the same moment — so its address, its storage
 * and its identity have to be things an installed app can never hold. Not
 * "unlikely to". Never. Both derivations below are collision-free by
 * CONSTRUCTION, against the manifest validator's own rules, and the tests assert
 * that by feeding the derived value back through the validator and watching it be
 * refused.
 *
 * Everything else — the tab strip, the panels, the sandbox, the navigation policy,
 * the bridge — is the installed path, unchanged and unforked. There is no preview
 * window implementation. There is a window, and a preview is a manifest wearing a
 * different name when it goes in.
 */

import { narrowGrant } from './manage-core';
import { gappHostname } from './hostname';
import { devSiteIdFor, slugLabel, type DevSiteConfig } from '../dev-server/sites-config';
import type { GappSourceLayout } from './install-plan';
import type { AppGrant } from './bridge-decision';
import type { AppManifest, AppScope } from './manifest';

/**
 * The separator in a preview's slug.
 *
 * A DOT, and the choice is load-bearing. An installed app's slug is a single DNS
 * LABEL — `validateAppManifest` refuses anything containing a dot — so a dotted
 * name cannot be claimed by any app, present or future. A hyphen would only be
 * unlikely to collide: `trader-preview` is a perfectly legal slug somebody could
 * register, and the day they did, previewing `trader` would serve onto their
 * address.
 */
const PREVIEW_SLUG_SUFFIX = '.preview';

/**
 * The mark in a preview's app id.
 *
 * A TILDE, for the same reason and against a different rule. Reverse-DNS admits
 * only `[a-z0-9]` separated by `.` or `-`, so `~` is impossible in a declared id.
 * It survives the partition sanitiser too: `appPartitionFor` rewrites anything
 * outside `[a-zA-Z0-9._-]` to `_`, and `_` is equally impossible in a real id — so
 * the *sanitised* string cannot collide either, which is the form that actually
 * names the storage.
 */
const PREVIEW_ID_MARK = '~preview';

/**
 * The `app_kind` a preview's workspace carries.
 *
 * Beside `app` (installed) and `app-dev` (installed in place). It is what makes a
 * preview's workspace identifiable as one from the outside — which teardown and
 * the boot sweep both depend on, because both are asked to DELETE something and
 * neither may take the developer's real workspace by mistake.
 */
export const PREVIEW_APP_KIND = 'app-preview';

export interface PreviewIdentity {
    /** Keys the bridge, the storage partition and the MCP caller id. */
    appId: string;
    /** Becomes `<slug>.gen` — the origin the preview's tabs resolve against. */
    slug: string;
}

export function previewIdentityFor(manifest: AppManifest): PreviewIdentity {
    return {
        appId: `${manifest.id}${PREVIEW_ID_MARK}`,
        slug: `${manifest.slug}${PREVIEW_SLUG_SUFFIX}`,
    };
}

/** Whether an app id belongs to a preview rather than to an installed app. */
export function isPreviewAppId(appId: string): boolean {
    return appId.endsWith(PREVIEW_ID_MARK);
}

/**
 * The manifest a preview window is BUILT from: the real one, wearing the preview
 * identity.
 *
 * This is the whole trick, and it is why there is no second window implementation.
 * `appWindowTabs` derives the app's origin from the manifest and from nothing
 * else; `appViewOptions` derives the storage partition from the manifest's id and
 * from nothing else. Both were written that way deliberately, so that there is
 * exactly ONE rule about where a tab points and whose cookies it gets.
 *
 * A previewer that passed a base url alongside the manifest would add a second
 * rule and destroy that property. Substituting the identity instead keeps one
 * rule: the preview does not need different code, it needs a different manifest.
 *
 * Nothing else changes. Panels, tabs, permissions, services, the front end — a
 * preview that quietly altered any of them would be a preview of a different app,
 * which is the one thing it must not be.
 */
export function previewManifest(manifest: AppManifest): AppManifest {
    const identity = previewIdentityFor(manifest);
    return { ...manifest, id: identity.appId, slug: identity.slug };
}

/** Widest first — a granted scope may sit at or below what the manifest declared. */
const SCOPE_WIDTH: Record<AppScope, number> = { self: 0, workspaces: 1, workstation: 2 };

export interface PreviewConsent {
    scope: AppScope;
    workspaces?: string[];
    /** What the user agreed this preview may do. */
    capabilities: string[];
}

/**
 * The grant a preview runs under.
 *
 * Ephemeral — it lives in memory for as long as the window is open and is never
 * written to the app registry — but it is a REAL grant in every other respect,
 * because the bridge it feeds is the real bridge. `decideAppCall` will read this
 * and refuse on it, and a preview whose grant were shaped differently would be a
 * preview of a different security model.
 *
 * Two ceilings are applied HERE rather than trusted from the caller. Being faster
 * is what a preview is for; being WIDER is not, and nothing about "it is not
 * installed" makes it safe to hold authority the developer never declared. The
 * capability set is narrowed with the same function the permissions screen uses,
 * so the two cannot drift.
 */
export function previewGrant(
    manifest: AppManifest,
    identity: PreviewIdentity,
    workspaceId: string,
    consent: PreviewConsent,
): AppGrant {
    const declared = manifest.permissions.scope;
    const scope =
        SCOPE_WIDTH[consent.scope] > SCOPE_WIDTH[declared] ? declared : consent.scope;

    return {
        appId: identity.appId,
        // `call-prep` stamps this on anything the app puts in front of the user —
        // a ForceTheQuestion modal, an AgentInbox message. Saying "(preview)" is
        // how the user tells a developer's throwaway window apart from the copy
        // they installed and trust; an unlabelled preview would be able to ask
        // them things in the installed app's voice.
        appName: `${manifest.name} (preview)`,
        workspaceId,
        scope,
        ...(scope === 'workspaces' && consent.workspaces ? { workspaces: consent.workspaces } : {}),
        capabilities: narrowGrant(manifest.permissions.capabilities, consent.capabilities),
        revoked: false,
    };
}

/** Just enough of a workspace row to decide whether a preview owns it. */
export interface PreviewWorkspaceRow {
    id: string;
    app_kind?: string | null;
}

/**
 * May this workspace be torn down as the given preview's?
 *
 * The load-bearing safety check of the feature. A preview's workspace points at
 * the DEVELOPER'S OWN FOLDER — that is what makes a preview show live source
 * instead of a copy — and Genie may well already have a real workspace row on that
 * same path. So "delete the workspace when the window closes" is one confused id
 * away from deleting the developer's project out of Genie.
 *
 * Two independent conditions, both required: the row must be the one this preview
 * recorded, AND it must still carry the mark this preview put on it. Either alone
 * would be an id comparison against something that could have been reused.
 */
export function mayTearDownPreviewWorkspace(
    row: PreviewWorkspaceRow | null | undefined,
    workspaceId: string,
): boolean {
    return !!row && row.id === workspaceId && row.app_kind === PREVIEW_APP_KIND;
}

/**
 * Preview workspaces that should not exist any more.
 *
 * A preview cannot outlive its window and a window cannot outlive the process, so
 * a preview workspace present at STARTUP is the residue of a crash or a kill. It
 * has nothing behind it — no window, no grant, no site — and sweeping it is what
 * keeps "closing the window is the whole cleanup" true even in the case where the
 * window never got the chance to close.
 *
 * Expressed as a rule rather than inlined into the sweep so it stays a claim that
 * can be asserted. The failure this guards against is not subtle in effect — a
 * sweep that matched on a name prefix, say — but it would be entirely silent.
 */
export function orphanedPreviewWorkspaces(rows: readonly PreviewWorkspaceRow[]): string[] {
    return rows.filter((r) => r.app_kind === PREVIEW_APP_KIND).map((r) => r.id);
}


/* -------------------------------------------------------------------------- */
/* Where a preview is SERVED                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The front end's directory, in the SOURCE layout.
 *
 * An install COPIES each declared component to `repos/<name>` and
 * `appInstallPlan` writes a site config that says so. A preview copies nothing —
 * the developer's folder IS the workspace — so the component sits wherever THAT
 * folder keeps it, and the component path is folded into the serve root with the
 * site pointed at the workspace root instead.
 *
 * Which is why the layout has to be passed in. A scaffolded staging folder keeps
 * the component at `web/`; a converted `.agi` envelope keeps it at `repos/web/`,
 * and previewing one used to point the docroot at a directory that was never
 * there — the same 404 this function exists to prevent, from the other side.
 *
 * The difference between the source and installed layouts is real, not an
 * accident, which is why this is a stated function rather than a `repos/` string
 * quietly dropped at the call site.
 */
function sourceServeRoot(
    repo: string | undefined,
    root: string,
    layout: GappSourceLayout,
): string {
    const rel = root.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!repo) return rel || '.';
    const component = layout === 'envelope' ? `repos/${repo}` : repo;
    // `root: '.'` is what the scaffold writes, and `web/.` is a docroot nobody
    // should have to reason about.
    return rel && rel !== '.' ? `${component}/${rel}` : component;
}

export interface PreviewSitePlan {
    siteId: string;
    site: DevSiteConfig;
}

/**
 * The hosting a preview needs: an ORDINARY Genie dev site, at the preview address.
 *
 * Deliberately the same {@link DevSiteConfig} an installed GApp gets, for the same
 * reason `appInstallPlan` emits one — a preview that invented its own serving path
 * would be a second hosting implementation to keep working, and the whole claim of
 * this feature is that a preview is the real thing.
 *
 * Two things differ from the installed plan, and both follow from what a preview
 * IS:
 *
 *   - the SOURCE layout, above, because nothing was copied;
 *   - no `browserExposed`, ever. Reaching the real browser installs a certificate
 *     and edits the hosts file — a one-time ADMIN prompt. An install may ask for
 *     that because the app declared it and the user agreed to install it. A
 *     throwaway preview window is not a reason to mutate the machine's trust
 *     store, and the developer can see their app perfectly well inside Genie.
 */
export function previewSitePlan(
    workspaceId: string,
    manifest: AppManifest,
    /**
     * How the developer's folder is laid out. Required rather than defaulted:
     * a default here would silently pick one of two real layouts and serve the
     * other one a docroot that does not exist.
     */
    layout: GappSourceLayout,
): PreviewSitePlan {
    const { slug, frontend } = manifest;
    // The ADDRESS keeps the dotted, collision-proof name. The site's NAME cannot:
    // a dev site name must be a single DNS label. Slugging it is safe where
    // slugging the address would not be — a name is scoped to ONE workspace, and a
    // preview's workspace is created for it and deleted with it.
    const name = slugLabel(slug);

    const site: DevSiteConfig = {
        name,
        genName: gappHostname(slug),
        // The component is in the serve root now, so the site is rooted at the
        // workspace — which for a preview is the developer's folder itself.
        repo: '',
        runMode: 'host',
        kind: 'http',
        enabled: true,
        ...(frontend.serve.mode === 'static'
            ? {
                  hostServe: {
                      mode: 'static' as const,
                      root: sourceServeRoot(frontend.repo, frontend.serve.root, layout),
                      ...(frontend.serve.spa ? { spa: true } : {}),
                  },
              }
            : // A `proxy` front end is the developer's OWN dev server on a port
              // they are already running. Genie fronts it and starts nothing,
              // which also makes previewing one the closest thing to free: the
              // reload loop is the dev server's.
              { hostPort: frontend.serve.hostPort }),
    };

    return { siteId: devSiteIdFor(workspaceId, name), site };
}
