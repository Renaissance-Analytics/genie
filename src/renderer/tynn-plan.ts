/**
 * IMPORT FROM TYNN: READING THE PLAN AFTER THE FOLDER IS PICKED (Tynn #688; the owner, beta.61: "picked the folder, and
 * nothing happened. No progress, no workspace, no error"). The one controller behind that step, as add-confirm.ts is
 * behind the confirm that follows it.
 *
 * - Progress from the moment the folder is picked until the host has answered, however it ends.
 * - A call that fails is said in words. It was `void … .then(…)` with no rejection handler, so a failure showed nothing.
 * - The project and folder are kept, so a failure here or in the confirm after it can be tried again without picking both
 *   a second time.
 * - One at a time: a second pick while one is being read starts nothing.
 */
export type TynnPlanAnswer = { ok: boolean; reason?: string };

export interface TynnPlanDeps<P extends TynnPlanAnswer> {
    setPlanning(planning: { projectId: string; parent: string } | null): void;
    setPick(pick: undefined): void;
    setPreview(preview: P | { ok: false; reason: string }): void;
    setRetry(retry: { projectId: string; parent: string } | null): void;
}

/** A failure, in the words it came with. */
export function failureWords(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `deps` is read at the moment it is needed, so a caller re-created every render is always current. */
export function tynnPlanner<P extends TynnPlanAnswer>(deps: () => TynnPlanDeps<P>): (run: (() => Promise<P> | undefined) | undefined, projectId: string, parent: string) => void {
    let running = false;
    return (run, projectId, parent) => {
        if (running) return;
        const asked = { projectId, parent };
        running = true;
        deps().setPlanning(asked);
        const show = (preview: P | { ok: false; reason: string }) => {
            deps().setRetry(asked);
            deps().setPick(undefined);
            deps().setPreview(preview);
        };
        let pending: Promise<P> | undefined;
        try {
            pending = run?.();
        } catch (error) {
            pending = Promise.reject(error);
        }
        (pending ?? Promise.reject(new Error('This Genie cannot read a Tynn project’s plan. Reconnect to it, then try again.')))
            .then(show, (error: unknown) => show({ ok: false, reason: failureWords(error) }))
            .finally(() => {
                running = false;
                deps().setPlanning(null);
            });
    };
}
