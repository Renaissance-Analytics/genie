/**
 * Backwards-compat re-exports.
 *
 * Tynn-specific HTTP lives in main/backend/tynn.ts now. Other callers in
 * main/ (auth.ts) import from here for convenience — they get a thin
 * facade over the TynnBackend singleton.
 */
import { getTynnBackend } from './backend/registry';
import { TynnAuthError } from './backend/tynn';

export { TynnAuthError };

export function tynnHost(): string {
    return getTynnBackend().host();
}

export async function whoami(): Promise<{
    id: string;
    name: string;
    email: string;
} | null> {
    const u = await getTynnBackend().whoami();
    if (!u) return null;
    return { id: u.id, name: u.name, email: u.email ?? '' };
}
