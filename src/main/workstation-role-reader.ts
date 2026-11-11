import { parseMeRole, type WorkstationRole } from '../core/workstation-role.js';

type TynnRequest = (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * What Tynn says this pairing is (genie#1278 W5): `GET /api/v1/workstations/me`, and nothing else. Any failure — a
 * refusal, an error, no network — is no answer, which a signed-in Genie treats as a drone (core/workstation-role.ts).
 */
export async function readWorkstationRole(request: TynnRequest): Promise<WorkstationRole | null> {
    return (await readWorkstationRoleOutcome(request)).role;
}

/** The same read, with what happened in words for the log (beta.61.1): pilot, drone, no answer, or failed and why. */
export async function readWorkstationRoleOutcome(request: TynnRequest): Promise<{ role: WorkstationRole | null; words: string }> {
    try {
        const res = await request('/api/v1/workstations/me', { method: 'GET' });
        if (!res.ok) return { role: null, words: `no answer (HTTP ${res.status})` };
        const body = (await res.json().catch(() => null)) as { role?: unknown } | null;
        const role = parseMeRole(body);
        if (role) return { role, words: role };
        // Tynn's own null: this sign-in is not bound to a workstation (WorkstationController::self). Not "no answer".
        if (body !== null && typeof body === 'object' && 'role' in body && body.role === null) return { role: null, words: 'null (this sign-in is not bound to a workstation)' };
        return { role: null, words: `no answer (HTTP ${res.status}, no role in it)` };
    } catch (error) {
        return { role: null, words: `failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
