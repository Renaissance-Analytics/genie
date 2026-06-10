/**
 * A `Backend` is one of the systems Genie shuttles between — currently
 * Tynn (SaaS) or Aionima (local LAN AGI). Each implementation:
 *
 *   - Holds its own credentials (session cookies, bearer token).
 *   - Resolves "who am I" against its own identity model.
 *   - Lists projects the user can write to.
 *   - Captures wishes / ideas.
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

    captureWish(projectId: string, content: string): Promise<BackendCaptureResult>;

    fetchInbox(): Promise<BackendInbox>;

    /** Opens the entity / path in the user's default browser. */
    openInBrowser(pathOrUrl: string): void;

    /** Drop credentials. */
    signOut(): Promise<void>;
}
