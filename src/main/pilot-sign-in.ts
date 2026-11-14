import type { CallContext } from '../core/remote-protocol.js';

/**
 * A SIGN-IN OPENS ON THE SCREEN THE PERSON IS AT (Tynn #731). A Pilot (a Genie window driving this machine over a relay
 * or the tailnet) signs in for the drone it drives: GitHub, GitHub's pages, Tynn, Tailscale. The link is sent over THAT
 * connection and opened by the Pilot's own Genie; this machine never opens a browser for a caller that is not its own window.
 * The caller is the one the host admitted for the call: no newest window, no other connection.
 */
export type OpenOnPilot = (connectionId: string, url: string) => Promise<void>;
type Open = (url: string) => Promise<void>;

/** Why this caller may not sign in for this machine, in words; `null` = it may (or it is this machine's own window). */
export function pilotRefusal(context: CallContext): string | null {
    if (context.origin === 'local-window') return null;
    if (context.readonly) return 'This connection is read-only, so it cannot sign in for this machine. Ask the owner for a full connection.';
    if (!context.isOwner && context.workspaceId !== null) return 'A guest of one workspace cannot sign in for this machine; only its owner, or a guest of the whole workstation, can.';
    return null;
}

/**
 * Where a caller's sign-in link opens: its own window when it is this machine's, its own connection when it is a Pilot.
 * `null` = nothing can open it (a local window with no opener); a refused caller throws, before anything is started.
 */
export function signInOpener(context: CallContext, local: Open | undefined, toPilot: OpenOnPilot): Open | null {
    if (context.origin === 'local-window') return local ?? null;
    const refusal = pilotRefusal(context);
    if (refusal) throw new Error(refusal);
    return url => toPilot(context.connectionId, url);
}

export interface SignInServices<Tynn extends { url: string }, Up extends { authUrl?: string | null }, Install extends { url?: string | null }, Target> {
    readonly tynnStart: () => Promise<Tynn>;
    readonly githubStart: (open: Open | null) => Promise<void>;
    readonly githubOpenPage: (target: Target, open: Open) => Promise<void>;
    readonly tailscaleUp: () => Promise<Up>;
    readonly tailscaleInstall: () => Promise<Install>;
}

/** The four sign-in effects for one admitted caller; every link goes through that caller's own opener. */
export function signInEffectsFor<Tynn extends { url: string }, Up extends { authUrl?: string | null }, Install extends { url?: string | null }, Target>(
    context: CallContext, local: Open | undefined, toPilot: OpenOnPilot, services: SignInServices<Tynn, Up, Install, Target>,
) {
    return {
        tynnStart: async (): Promise<Tynn> => {
            const open = signInOpener(context, local, toPilot);
            const answer = await services.tynnStart();
            if (open) await open(answer.url);
            return answer;
        },
        githubStart: async (): Promise<void> => services.githubStart(signInOpener(context, local, toPilot)),
        tailscaleUp: async (): Promise<Up> => {
            const open = signInOpener(context, local, toPilot);
            const answer = await services.tailscaleUp();
            if (answer.authUrl) {
                if (!open) throw new Error('Tailscale needs a sign-in; open Genie on this machine and Connect there');
                await open(answer.authUrl);
            }
            return answer;
        },
        githubOpen: async (target: Target): Promise<void> => {
            const open = signInOpener(context, local, toPilot);
            if (!open) throw new Error('this window cannot open GitHub');
            await services.githubOpenPage(target, open);
        },
        tailscaleInstall: async (): Promise<Install> => {
            const open = signInOpener(context, local, toPilot);
            const answer = await services.tailscaleInstall();
            if (answer.url) {
                if (!open) throw new Error('this window cannot open the installer page');
                await open(answer.url);
            }
            return answer;
        },
    };
}
