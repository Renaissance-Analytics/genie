import { parseMeRole, type WorkstationRole } from '../core/workstation-role.js';

type TynnRequest = (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * What Tynn says this pairing is (genie#1278 W5): `GET /api/v1/workstations/me`, and nothing else. Any failure — a
 * refusal, an error, no network — is no answer, which a signed-in Genie treats as a drone (core/workstation-role.ts).
 */
export async function readWorkstationRole(request: TynnRequest): Promise<WorkstationRole | null> {
    try {
        const res = await request('/api/v1/workstations/me', { method: 'GET' });
        if (!res.ok) return null;
        return parseMeRole(await res.json().catch(() => null));
    } catch {
        return null;
    }
}
