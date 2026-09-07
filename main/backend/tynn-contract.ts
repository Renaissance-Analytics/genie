/**
 * The Tynn HTTP endpoints Genie depends on — declared, so that retiring one
 * fails a TEST here rather than a user's hotkey.
 *
 * ## Why this file exists
 *
 * Tynn folded Wishes into a single Issue intake and `POST /api/v1/wishes` went
 * with them. Quick capture kept posting there and 404'd on every keystroke for
 * a day, and NEITHER repository's suite could see it (genie#411): Tynn's tests
 * have no knowledge of a desktop client, and Genie's had no knowledge of which
 * Tynn routes exist. Two green suites either side of a dead integration.
 *
 * Nothing about that was specific to capture. Every entry below is a route
 * Tynn could retire tomorrow with a passing Tynn suite, and the first person to
 * find out would be whoever pressed the key.
 *
 * ## How it is checked
 *
 * Two halves, and each is worthless without the other:
 *
 *  - `__tests__/tynn-contract.test.ts` — OFFLINE, runs on every `npm test`. It
 *    parses Genie's own source and fails if this manifest has drifted from the
 *    client. A live probe of a stale manifest checks the wrong endpoints and
 *    still goes green.
 *  - `__tests__/tynn-contract.live.test.ts` — probes the REAL Tynn and fails on
 *    a retirement. It runs in its own lane (`npm run test:contract`), never in
 *    `npm test`, so the unit suite stays offline; and it FAILS rather than skips
 *    when Tynn cannot be reached, because a contract test that goes green when
 *    it could not check is the exact defect it exists to prevent.
 *
 * ## Adding an endpoint
 *
 * Declare it here in the same commit that calls it. The offline test will tell
 * you if you forget — that is what it is for.
 */

/** The methods Genie uses against Tynn. */
export type TynnMethod = 'GET' | 'POST' | 'PUT';

export interface TynnEndpoint {
    /** The method Genie sends. Asserted against Tynn's own `Allow` header. */
    method: TynnMethod;
    /**
     * The path as Tynn registers it. A `{name}` segment is a route parameter;
     * the live probe fills it with a syntactically valid placeholder, which is
     * enough because a probe never reaches model binding (see PROBE_METHOD).
     */
    path: string;
    /** Repo-relative file whose source builds this request. */
    caller: string;
    /**
     * The literal to look for in `caller`, when the path is assembled across
     * statements and so never appears whole in the source. Defaults to the
     * static part of `path`.
     */
    evidence?: string;
    /** What stops working for a user when this route stops resolving. */
    breaks: string;
}

/**
 * The method the live probe sends, and why it is safe against production.
 *
 * Laravel answers an OPTIONS request for a path that has ANY route with a
 * synthesized 200 carrying an `Allow` header, built inside the router before a
 * single piece of route middleware runs — so the probe never authenticates,
 * never touches CSRF, never binds a model and never reaches a controller. A
 * path with no route 404s exactly as it would for any other method.
 *
 * Confirmed against production while building this (unauthenticated, read-only):
 *
 *   OPTIONS /api/v1/issues  -> 200  allow: POST          (the live route)
 *   OPTIONS /api/v1/wishes  -> 404                       (the retired one)
 *   OPTIONS /api/v1/me      -> 200  allow: GET,HEAD
 *   OPTIONS /api/v1/projects-> 200  allow: GET,HEAD,POST
 *
 * The alternative — sending each endpoint's REAL method — would put unauthorized
 * writes on production every time the suite ran, and could not tell a retired
 * route from a rejected one without reading status codes that mean different
 * things per endpoint.
 */
export const PROBE_METHOD = 'OPTIONS';

/** Where the contract lives unless `TYNN_CONTRACT_BASE` says otherwise. */
export const TYNN_PRODUCTION = 'https://tynn.ai';

/**
 * Collapse a path to a comparable shape: any `{param}` becomes `{}`, so the
 * declared `/api/v1/workstations/{workstation}/enroll` and a source template
 * that interpolates an id are the same string.
 */
export function normalizePath(p: string): string {
    return p.replace(/\{[^}]*\}/g, '{}');
}

/** A concrete path to probe: route parameters filled with a valid placeholder. */
export function probePath(endpoint: TynnEndpoint): string {
    // A UUID-shaped placeholder, so a route whose parameter is constrained by
    // pattern still matches. Nothing resolves it — OPTIONS is answered before
    // model binding — but a path that cannot even be parsed would 404 and read
    // as a retirement.
    return endpoint.path.replace(/\{[^}]*\}/g, '00000000-0000-4000-8000-000000000000');
}

export const TYNN_ENDPOINTS: readonly TynnEndpoint[] = [
    // ── The session-cookie surface (Tynn `routes/web.php`, prefix `api/v1`) ──
    // Genie is the USER here, not an agent: it holds a laravel_session dropped by
    // the `genie://` sign-in callback, which is why these live in web.php rather
    // than routes/api.php.
    {
        method: 'GET',
        path: '/api/v1/me',
        caller: 'main/backend/tynn.ts',
        breaks: 'Genie cannot tell who is signed in; every Tynn surface reads as signed out.',
    },
    {
        method: 'GET',
        path: '/api/v1/projects',
        caller: 'main/backend/tynn.ts',
        breaks: 'The workspace/project picker is empty and nothing can be linked to Tynn.',
    },
    {
        method: 'POST',
        path: '/api/v1/projects',
        caller: 'main/backend/tynn.ts',
        breaks: 'A new workspace cannot create its Tynn project.',
    },
    {
        method: 'GET',
        path: '/api/v1/projects/owner-options',
        caller: 'main/backend/tynn.ts',
        breaks: 'Project creation cannot offer the orgs the user may create under.',
    },
    {
        method: 'POST',
        path: '/api/v1/projects/agent-token',
        caller: 'main/backend/tynn.ts',
        breaks: 'A workspace cannot mint its Tynn MCP token, so agents get no Tynn tools.',
    },
    {
        method: 'POST',
        path: '/api/v1/projects/declare-envelope',
        caller: 'main/backend/tynn.ts',
        breaks: 'An `.agi` workspace never registers as an envelope, so IssueWatch never polls it.',
    },
    {
        method: 'POST',
        path: '/api/v1/projects/hosted-sites',
        caller: 'main/backend/tynn.ts',
        breaks: 'Hosted sites stop mirroring to Tynn and the hosting control UX goes stale.',
    },
    {
        method: 'POST',
        path: '/api/v1/projects/ops-slaves',
        caller: 'main/backend/tynn.ts',
        breaks: 'Ops workspaces cannot resolve their child roster.',
    },
    {
        method: 'GET',
        path: '/api/v1/features',
        caller: 'main/backend/tynn.ts',
        breaks: 'Entitlements read as off, silently disabling AgentInbox and IssueWatch.',
    },
    {
        method: 'GET',
        path: '/api/v1/broadcasting-config',
        caller: 'main/backend/tynn.ts',
        breaks: 'No Pusher key, so every real-time push channel stays down.',
    },
    {
        method: 'POST',
        path: '/api/v1/workstations/self-register',
        caller: 'main/backend/tynn.ts',
        breaks: 'This machine cannot enrol itself as the local workstation.',
    },
    {
        method: 'POST',
        path: '/api/v1/issues',
        caller: 'main/backend/tynn.ts',
        breaks: 'The global quick-capture hotkey files nothing — genie#411, the bug this file exists for.',
    },
    {
        method: 'POST',
        path: '/api/v1/feedback',
        caller: 'main/backend/tynn.ts',
        breaks: 'Feedback about Genie itself never reaches Tynn. The PATH is frozen by Tynn on purpose: installed desktops post here and their release is not ours to control.',
    },
    {
        method: 'GET',
        path: '/api/v1/me/inbox',
        caller: 'main/backend/tynn.ts',
        breaks: 'The tray badge and desktop notifications go permanently quiet.',
    },
    {
        method: 'GET',
        path: '/api/v1/user/issue-watch',
        caller: 'main/tynn/user-channel-issuewatch.ts',
        breaks: 'IssueWatch never reconciles on connect and freezes on whatever it last held (tynn.ai#151).',
    },
    {
        method: 'POST',
        path: '/api/v1/user/issue-watch/refresh',
        caller: 'main/issue-watch/force-refresh.ts',
        breaks: 'Asking IssueWatch to refresh NOW does nothing; the flyout waits out the poll tick.',
    },
    {
        method: 'POST',
        path: '/api/v1/user/broadcasting-auth',
        caller: 'main/tynn/user-channel-issuewatch.ts',
        breaks: "The desktop's own user channel cannot authorize, killing IssueWatch push (tynn.ai#154/#155).",
    },
    {
        method: 'GET',
        path: '/workstations/connectable',
        caller: 'main/backend/tynn.ts',
        breaks: 'The Hosts picker shows no workstations, so no remote host can be reached.',
    },
    {
        method: 'POST',
        path: '/workstations/{workstation}/connect-grant',
        caller: 'main/backend/tynn.ts',
        evidence: '/workstations/',
        breaks: 'No connect grant can be minted, so connecting to a Virtual Workstation fails outright.',
    },

    // ── The host-facing surface (Tynn `routes/api.php`) ─────────────────────
    // Stateless and signature-authed: the headless host and genie-cloud call
    // these with an enrolled Ed25519 identity, not a cookie.
    {
        method: 'POST',
        path: '/api/v1/workstations/grants/introspect',
        caller: 'main/backend/tynn.ts',
        breaks: 'A member cannot heartbeat its grant, so a live remote session reads as revoked.',
    },
    {
        method: 'POST',
        path: '/api/v1/workstations/{workstation}/enroll',
        caller: 'main/tynn/local-workstation.ts',
        evidence: '/api/v1/workstations/',
        breaks: 'A workstation cannot exchange its enrolment credential for a host token — it never comes online.',
    },
    {
        method: 'PUT',
        path: '/api/v1/workstations/{workstation}/inventory',
        caller: 'main/tynn/local-workstation.ts',
        evidence: '/inventory',
        breaks: 'Tynn never learns which workspaces and sites this host holds, so the fleet view goes stale.',
    },
    {
        method: 'GET',
        path: '/api/v1/workstations/{workstation}/issue-watch',
        caller: 'main/tynn/local-workstation.ts',
        evidence: '/issue-watch',
        breaks: 'A host-authed workstation never reconciles IssueWatch, so its badges freeze.',
    },
    {
        method: 'POST',
        path: '/api/v1/workstations/{workstation}/broadcasting-auth',
        caller: 'main/tynn/pusher-transport.ts',
        evidence: '/api/v1/workstations/',
        breaks: "A host cannot authorize its private channel, so workspace-assignment PUSH never arrives.",
    },
    {
        method: 'POST',
        path: '/api/v1/workstations/{workstation}/encryption-key',
        caller: 'main/tynn/managed-credential-client.ts',
        evidence: '/encryption-key',
        breaks: 'A host cannot publish its X25519 key, so no managed credential can ever be sealed to it.',
    },
    {
        method: 'GET',
        path: '/api/v1/workstations/{workstation}/provider-credentials',
        caller: 'main/tynn/managed-credential-client.ts',
        evidence: '/provider-credentials',
        breaks: 'A host gets no managed provider credentials — agents on it cannot authenticate.',
    },
    {
        method: 'PUT',
        path: '/api/v1/workstations/{workstation}/provider-credentials/{credential}',
        caller: 'main/tynn/managed-credential-client.ts',
        evidence: '/provider-credentials/',
        breaks: 'A rotated credential is never written back, so the next boot uses a dead token.',
    },
    {
        method: 'GET',
        path: '/api/v1/workstations/{workstation}/escrow/pending',
        caller: 'main/tynn/managed-credential-client.ts',
        evidence: '/escrow/pending',
        breaks: 'Newly provisioned hosts are never noticed, so the fleet stops self-healing.',
    },
    {
        method: 'POST',
        path: '/api/v1/workstations/{workstation}/escrow/wrapped-keys',
        caller: 'main/tynn/managed-credential-client.ts',
        evidence: '/escrow/wrapped-keys',
        breaks: 'A sibling host never receives the escrow key and can open no credential.',
    },
];
