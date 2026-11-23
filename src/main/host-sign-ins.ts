import { DESIGN_LOGIN } from '../core/design-login.js';
import type { CallContext } from '../core/remote-protocol.js';
import { loginRoute } from './login-host.js';

/**
 * SIGN-INS, STARTED BY GENIE-HOST FOR WHOEVER ASKED (client/host split step 2b, Tynn #896; the coordinator's ruling,
 * 2026-11-19). An agent's provider login (`providerLogin`), the machine's design sign-in (`logins.design`), a switch of
 * account (`accounts.switch`), and a feature's or the tray's login by provider.
 *
 * The host runs the PROVIDER'S OWN login in a terminal (login-host.ts): the person signs in there, to the provider.
 * Genie never reads, writes or relays a credential (the owner's rule for subscription accounts).
 *
 * The client that asked opens that terminal's window. For this machine's window, its process is asked here
 * (`openWindow`, the same `terminal.window` op as Take Over), and the login is cancelled when that window closes.
 * Another machine's window gets the route back and opens its own, with a companion ticket from RemoteHost.
 */
export type SignInAnswer = { ok: true; terminalId: string; route: string } | { ok: true; browser: true } | { ok: false; reason: string };

export interface SignInPorts {
    /** LoginHost.start: the provider's own login, its active account's (or the one named). */
    readonly login: (provider: string, accountId?: string) => { ok: true; terminalId: string } | { ok: false; reason: string };
    /** A switch of account: the provider's own login in its one home, with the steps on screen (Tynn #753). */
    readonly switchLogin: (provider: string) => { ok: true; terminalId: string } | { ok: false; reason: string };
    /** The provider an agent runs on; null = no such agent. */
    readonly providerOf: (agentId: string) => string | null;
    /** LoginHost.cancel, by the login's terminal: the person left the step. */
    readonly cancel: (terminalId: string) => void;
    /**
     * Opens `route`'s window on the caller's window process, when this machine's window asked; `closed` runs when that
     * window closes. False = not one of this machine's windows (another machine opens its own).
     */
    readonly openWindow: (context: CallContext | undefined, route: string, closed: () => void) => boolean;
    /**
     * CLAUDE SIGNS IN IN THE BROWSER, NEVER A TERMINAL (Tynn #1011; the owner: "I should not see any terminals"): prism-acp's
     * hidden login, Anthropic's page opened in the person's browser. `choose`: the account a switch named (its email), if any.
     */
    readonly claudeBrowser?: ((choose: string | undefined, context: CallContext | undefined, switching: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined;
}

export interface HostSignIns {
    providerLogin(agentId: string, context?: CallContext): Promise<SignInAnswer>;
    design(context?: CallContext): Promise<SignInAnswer>;
    switchAccount(provider: string, choose: unknown, context?: CallContext): Promise<SignInAnswer>;
    loginFor(provider: string, context?: CallContext): Promise<SignInAnswer>;
}

/** The account to choose is words for the steps only: kept short, on one line, never a control character (it goes into a route). */
function chooseOf(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.trim() !== '' && raw.length <= 320 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw.trim() : undefined;
}

export function hostSignIns(ports: SignInPorts): HostSignIns {
    const shown = (started: { ok: true; terminalId: string } | { ok: false; reason: string }, route: (terminalId: string) => string, context: CallContext | undefined): SignInAnswer => {
        if (!started.ok) return { ok: false, reason: started.reason };
        const at = route(started.terminalId);
        ports.openWindow(context, at, () => ports.cancel(started.terminalId));
        return { ok: true, terminalId: started.terminalId, route: at };
    };
    const browser = async (choose: string | undefined, context: CallContext | undefined, switching: boolean): Promise<SignInAnswer> => {
        const r = await ports.claudeBrowser!(choose, context, switching);
        return r.ok ? { ok: true, browser: true } : r;
    };
    const loginFor = async (provider: string, context?: CallContext): Promise<SignInAnswer> =>
        provider === 'claude' && ports.claudeBrowser ? browser(undefined, context, false) : shown(ports.login(provider), (id) => loginRoute(id, provider), context);
    return {
        loginFor,
        providerLogin: async (agentId, context) => {
            const provider = ports.providerOf(agentId);
            if (provider === null) return { ok: false, reason: 'No agent named.' };
            return loginFor(provider, context);
        },
        // One design sign-in for the machine (Tynn #480): the interactive `claude` in its one home.
        design: async (context) => loginFor(DESIGN_LOGIN, context),
        switchAccount: async (provider, choose, context) => {
            if (typeof provider !== 'string' || provider === '') return { ok: false, reason: 'No provider named.' };
            const named = chooseOf(choose);
            if (provider === 'claude' && ports.claudeBrowser) return browser(named, context, true);
            return shown(ports.switchLogin(provider), (id) => loginRoute(id, provider, true, named), context);
        },
    };
}
