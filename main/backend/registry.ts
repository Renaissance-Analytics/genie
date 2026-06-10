import type { Backend, BackendKind, BackendProject, BackendUser } from './backend';
import { TynnBackend } from './tynn';
import { AionimaBackend } from './aionima';

/**
 * One instance per backend kind, lazily created. The renderer never
 * touches these directly — IPC handlers in main/ipc.ts call into the
 * registry and fan out across whichever backends are configured.
 */

let tynn: TynnBackend | null = null;
let aionima: AionimaBackend | null = null;

export function getTynnBackend(): TynnBackend {
    return (tynn ??= new TynnBackend());
}

export function getAionimaBackend(): AionimaBackend {
    return (aionima ??= new AionimaBackend());
}

export function backendOfKind(kind: BackendKind): Backend {
    return kind === 'aionima' ? getAionimaBackend() : getTynnBackend();
}

/**
 * All backends that have a non-empty host configured. A configured
 * backend does NOT imply the user is signed in — only that Genie knows
 * where to ask. `whoami()` is the truth check.
 */
export function allConfiguredBackends(): Backend[] {
    const out: Backend[] = [];
    const t = getTynnBackend();
    if (t.host()) out.push(t);
    const a = getAionimaBackend();
    if (a.isConfigured()) out.push(a);
    return out;
}

/**
 * Returns whichever backends the user is currently signed in to. Used
 * by the tray sign-in prompt to decide what to show.
 */
export async function signedInBackends(): Promise<
    Array<{ backend: Backend; user: BackendUser }>
> {
    const out: Array<{ backend: Backend; user: BackendUser }> = [];
    for (const b of allConfiguredBackends()) {
        const u = await b.whoami();
        if (u) out.push({ backend: b, user: u });
    }
    return out;
}

/** Union of projects across every configured + signed-in backend. */
export async function listAllProjects(): Promise<BackendProject[]> {
    const out: BackendProject[] = [];
    for (const { backend } of await signedInBackends()) {
        const rows = await backend.listProjects();
        out.push(...rows);
    }
    return out;
}

/** Sum of inbox counts across every signed-in backend, plus merged events. */
export async function fetchMergedInbox(): Promise<{
    count: number;
    events: Array<{
        id: string;
        backend: BackendKind;
        kind: string;
        actor: string;
        subject: string;
        url: string;
        when: string;
    }>;
}> {
    let count = 0;
    const events: Array<{
        id: string;
        backend: BackendKind;
        kind: string;
        actor: string;
        subject: string;
        url: string;
        when: string;
    }> = [];
    for (const { backend } of await signedInBackends()) {
        const inbox = await backend.fetchInbox();
        count += inbox.count;
        for (const e of inbox.events) {
            events.push({ ...e, backend: backend.kind });
        }
    }
    return { count, events };
}
