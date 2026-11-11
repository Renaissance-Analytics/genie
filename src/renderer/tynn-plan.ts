/** Reading a Tynn import's plan after the folder is picked (Tynn #688). The red commit's stand-in: what App did inline. */
export type TynnPlanAnswer = { ok: boolean; reason?: string };

export interface TynnPlanDeps<P extends TynnPlanAnswer> {
    setPlanning(planning: { projectId: string; parent: string } | null): void;
    setPick(pick: undefined): void;
    setPreview(preview: P | { ok: false; reason: string }): void;
    setRetry(retry: { projectId: string; parent: string } | null): void;
}

export function tynnPlanner<P extends TynnPlanAnswer>(deps: () => TynnPlanDeps<P>): (run: (() => Promise<P> | undefined) | undefined, projectId: string, parent: string) => void {
    return (run) => {
        void run?.()?.then((p) => { deps().setPick(undefined); deps().setPreview(p); });
    };
}
