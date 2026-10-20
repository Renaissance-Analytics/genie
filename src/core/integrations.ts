/**
 * TYNN, GITHUB, CONFIG SYNC (§6.9) — the pure half.
 *
 * - Tynn is the OPTIONAL identity layer. Genie is fully usable signed out, and a Tynn-gated row is
 *   ANNOTATED with the reason and the route, never dropped — a row that vanishes on sign-out reads
 *   as a feature that broke.
 * - GitHub is its own module now (core/github.ts, main/github-account.ts): Genie 1's sign-in and the real status GitHub
 *   reports, not two steps the person ticked (beta.33 item 25).
 * - Config sync writes to FOUR independent targets; each reports its own result, and one failing
 *   never blocks or hides the others.
 */

export interface GatedRow {
    readonly id: string;
    readonly label: string;
    /** Needs a Tynn sign-in. */
    readonly tynn: boolean;
}

export interface AnnotatedRow extends GatedRow {
    readonly enabled: boolean;
    readonly note: string | null;
    readonly route: string | null;
}

export function tynnGate(rows: readonly GatedRow[], state: { signedIn: boolean }): AnnotatedRow[] {
    return rows.map((r) =>
        r.tynn && !state.signedIn
            ? { ...r, enabled: false, note: 'Sign in to Tynn to use this', route: 'genie://settings/tynn' }
            : { ...r, enabled: true, note: null, route: null },
    );
}

export interface SyncTarget {
    readonly id: string;
    readonly label: string;
    readonly write: (payload: Readonly<Record<string, string>>) => Promise<void>;
}

export interface SyncResult {
    readonly id: string;
    readonly label: string;
    readonly ok: boolean;
    readonly error?: string;
}

const TARGET_COUNT = 4;

/** Four independent targets, each with its own result. Never all-or-nothing. */
export async function configSync(targets: readonly SyncTarget[], payload: Readonly<Record<string, string>>): Promise<SyncResult[]> {
    if (targets.length !== TARGET_COUNT) throw new Error(`config sync writes to four independent targets; got ${targets.length}`);
    return Promise.all(
        targets.map(async (t) => {
            try {
                await t.write(payload);
                return { id: t.id, label: t.label, ok: true };
            } catch (error) {
                return { id: t.id, label: t.label, ok: false, error: (error as Error).message };
            }
        }),
    );
}
