/** What the window says when genie-host cannot start (Tynn #415). Not built yet: the red commit's stand-in. */
export interface HostDownPlan {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly string[];
}

export function hostDownPlan(_input: { readonly reason: string | null; readonly logFile: string }): HostDownPlan {
    return { title: '', message: '', detail: '', buttons: [] };
}

export type HostDownAnswer = 'retry' | 'open-log' | 'quit';

export function hostDownAnswer(_button: number): HostDownAnswer {
    return 'quit';
}
