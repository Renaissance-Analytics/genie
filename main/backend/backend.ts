/**
 * A `Backend` is one of the systems Genie shuttles between — currently
 * Tynn (SaaS) or Aionima (local LAN AGI). Each implementation:
 *
 *   - Holds its own credentials (session cookies, bearer token).
 *   - Resolves "who am I" against its own identity model.
 *   - Lists projects the user can write to.
 *   - Captures ideas as issues.
 *   - Surfaces an inbox the tray badge polls.
 *   - Opens entity URLs in the user's browser.
 *
 * The renderer never sees backend internals — it asks for "the user's
 * projects" via IPC and main fans the request out to whichever backends
 * the user has connected.
 */

export type BackendKind = 'tynn' | 'aionima';

export interface BackendUser {
    backend: BackendKind;
    id: string;
    name: string;
    email?: string;
    /** Aionima sub-users / dashboard users have a kind; Tynn does not. */
    kind?: string;
}

export interface BackendProject {
    backend: BackendKind;
    id: string;
    name: string;
    slug: string;
    owner_type?: string;
    owner_name?: string;
    /** Web URL for the project's home page on this backend. */
    base_url?: string;
    /**
     * This project is where a Genie App is DEVELOPED (Tynn `is_gapp`,
     * tynn.ai#204 / genie#245). A human sets it on the Tynn project; nothing
     * infers it.
     *
     * It is NOT a link to an INSTALLED GApp. An installed app never receives a
     * developer's Tynn data — the GApp store's service side owns the
     * listing↔project relationship. See
     * `.ai/plans/gapp-store-and-tynn-linkage.md`.
     *
     * Optional because only Tynn declares it; backends that have no such
     * concept leave it undefined.
     */
    isGapp?: boolean;
    isWorkspace?: boolean;
    /**
     * The one otherwise-reserved agent name this project's workspace may use —
     * a SACRED workspace (Tynn story #262). A human marks it on the Tynn
     * project; nothing infers it, exactly like `isGapp`.
     *
     * A NAME rather than a boolean, because Genie would otherwise have to guess
     * WHICH reserved term was granted, and the obvious guess (the slug) is wrong
     * in the one case that matters: the Tynn workspace's slug is `tynn-ai` while
     * the name it needs is `tynn`.
     *
     * Optional because only Tynn declares it; a backend with no such concept —
     * and a Tynn that predates the field — leaves it undefined, which reads as
     * "not marked".
     */
    sacredAgentName?: string | null;
    repositories?: Array<{
        url: string;
        defaultBranch?: string;
        kind?: 'code' | 'knowledge' | 'envelope';
    }>;
}

export interface BackendInboxEvent {
    id: string;
    kind: string;
    actor: string;
    subject: string;
    url: string;
    when: string;
}

export interface BackendInbox {
    backend: BackendKind;
    count: number;
    events: BackendInboxEvent[];
}

export interface BackendCaptureResult {
    id: string;
    backend: BackendKind;
}

export interface Backend {
    kind: BackendKind;

    /** Human-friendly host label for UI (e.g. "https://tynn.ai" or "http://192.168.0.144:3100"). */
    host(): string;

    /** Null if not signed in / not paired. Should NOT throw on auth failure. */
    whoami(): Promise<BackendUser | null>;

    listProjects(): Promise<BackendProject[]>;

    /**
     * File what the global quick-capture hotkey caught.
     *
     * It makes an ISSUE. Tynn used to keep Wishes and Issues apart and this
     * posted to the Wish intake; that intake is retired, and the one thing a
     * captured idea can become now is an Issue.
     */
    captureIssue(projectId: string, content: string): Promise<BackendCaptureResult>;

    /**
     * File FEEDBACK about the product against a project (Tynn #249).
     *
     * Distinct from {@link captureIssue} at the WIRE, which is the only place
     * they still differ: quick capture posts to `/api/v1/issues`, feedback to
     * `/api/v1/feedback`. Both make an Issue Tynn-side, but the paths are a
     * contract with desktops already installed, so neither may be folded into
     * the other.
     *
     * `meta` carries the context that makes a report actionable later — Genie
     * version, workspace, and for an agent its terminal. The SOURCE is stamped by
     * the server, not here.
     */
    submitFeedback(
        projectId: string,
        message: string,
        meta?: Record<string, string>,
    ): Promise<BackendCaptureResult>;

    fetchInbox(): Promise<BackendInbox>;

    /** Opens the entity / path in the user's default browser. */
    openInBrowser(pathOrUrl: string): void;

    /** Drop credentials. */
    signOut(): Promise<void>;
}
