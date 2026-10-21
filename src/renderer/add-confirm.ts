/**
 * CONFIRMING AN ADD (parity rows 25 and 38) — the one controller behind the plan's confirm button for Open existing,
 * Import from Git and Import from Tynn.
 *
 * - One at a time: while an add runs, another confirm starts nothing. The button is disabled too, but a second click can
 *   land before React redraws it, and a clone can take minutes — two clones into one folder is the failure this stops.
 * - Busy for the whole run, freed however it ends (an answer, a refusal, a throw), so the button never sticks on
 *   "Cloning…".
 * - Success opens the workspace it added, as New does; a refusal replaces the plan with its reason.
 */

export type AddOutcome = { ok: true; id: string } | { ok: false; reason: string };

export interface AddConfirmDeps {
    setBusy(busy: boolean): void;
    setPreview(preview: { ok: false; reason: string } | null): void;
    open(route: string): void;
}

/** `deps` is read at the moment it is needed, so a caller re-created every render (App's navigate) is always current. */
export function addConfirmer(deps: () => AddConfirmDeps): (run: () => Promise<AddOutcome> | undefined) => void {
    let running = false;
    return (run) => {
        if (running) return;
        const pending = run();
        if (!pending) return;
        running = true;
        deps().setBusy(true);
        pending
            .then(
                (r) => {
                    if (r.ok) {
                        deps().setPreview(null);
                        deps().open(`genie://workspace/${r.id}`);
                    } else {
                        deps().setPreview({ ok: false, reason: r.reason });
                    }
                },
                (error: unknown) => deps().setPreview({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
            )
            .finally(() => {
                running = false;
                deps().setBusy(false);
            });
    };
}
