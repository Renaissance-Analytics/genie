import { catalogEditors, catalogPanels } from '../core/catalog-projections.js';
import { tynnGate } from '../core/integrations.js';
import { TYNN_HOST } from '../core/tynn.js';
import { signedOutGithubView } from '../core/github.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { WindowServices } from './compose.js';
import type { FeaturePorts, FeatureState } from './feature-ipc.js';
import type { TynnAccountPort } from './tynn-account.js';
import { unreachableThroughMessage } from './tynn-account.js';
import type { GithubAccountPort } from './github-account.js';
import { FIREWALL_RULE_NAME } from './remote-firewall.js';

/** Machine contributors supplied by their owner; this module never composes services or picks a window. */
export type MachineFeatureServices = Pick<WindowServices, 'remote' | 'pairing' | 'pluginsDir' | 'catalogDefinitions'
    | 'integrations' | 'syncAgentDocs' | 'syncConfig'> & {
    readonly settings: Pick<WindowServices['settings'], 'snapshot'>;
    readonly plugins: Pick<WindowServices['plugins'], 'list' | 'setEnabled' | 'setNetworkAllowed'>;
    readonly workspaceTrust: Pick<WindowServices['workspaceTrust'], 'trust' | 'untrust'>;
};
export type MachineFeaturePorts = Pick<FeaturePorts, 'tynnAccount' | 'githubAccount' | 'keyring' | 'issueWatch'
    | 'issueWatchRefresh' | 'issueWatchSetRepo' | 'tailscale' | 'firewall' | 'toolchain' | 'tynnWorkstation'
    | 'remoteAccess' | 'appVersion' | 'whatsNew'>;

/** The account, or a refusal in words: without one nothing pretends to sign in. */
function tynnAccountOf(ports: MachineFeaturePorts): TynnAccountPort {
    if (!ports.tynnAccount) throw new Error('this Genie cannot sign in to Tynn here: it has no Tynn account (doctor mode)');
    return ports.tynnAccount;
}

const NO_GITHUB = 'this Genie cannot sign in to GitHub here: it has no GitHub account (doctor mode)';

/** The GitHub sign-in, or a refusal in words: without one nothing pretends to sign in. */
export function githubAccountOf(ports: MachineFeaturePorts): GithubAccountPort {
    if (!ports.githubAccount) throw new Error(NO_GITHUB);
    return ports.githubAccount;
}

/** Tynn in Settings → Integrations: who is signed in where, the sign-in under way, and the rows Tynn gates. */
function tynnIntegration(state: FeatureState, account: TynnAccountPort | undefined) {
    const status = account?.status() ?? { signedIn: false as const };

    const host = account ? account.host() : TYNN_HOST;
    // Out of reach through a proxy reads as that: the sign-in stands, whatever the status says for now.
    const through = account?.unreachableThrough?.() ?? null;
    return {
        tynnSignedIn: status.signedIn,
        tynn: { host, user: status.signedIn ? status.user : null, signInUrl: status.signedIn ? null : state.tynnSignInUrl ?? null, message: state.tynnMessage ?? (through ? unreachableThroughMessage(through) : null) },
        gated: tynnGate([{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true }], { signedIn: status.signedIn }),
    };
}

/** Identical machine facts for the window and the host, with caller state supplied explicitly. */
export function machineFeatureSnapshot(services: MachineFeatureServices, state: FeatureState, ports: MachineFeaturePorts):
    Pick<FeatureData, 'integrations' | 'issueWatch' | 'version' | 'whatsNew' | 'plugins' | 'remote'> {
    return {
        // GitHub as the account read it from GitHub (beta.33 item 25) — never a value a window sent.
        integrations: { ...tynnIntegration(state, ports.tynnAccount), github: ports.githubAccount ? ports.githubAccount.view() : signedOutGithubView(NO_GITHUB), ...services.integrations(), lastSync: state.lastSync ?? null, keyring: ports.keyring?.view() ?? null, ...(ports.keyring?.notice?.() ? { keyringNotice: ports.keyring.notice!() } : {}) },
        issueWatch: ports.issueWatch ? ports.issueWatch() : null,
        version: ports.appVersion ? ports.appVersion() : null,
        whatsNew: ports.whatsNew ? ports.whatsNew(state.whatsNewShown === true) : null,
        plugins: { dir: services.pluginsDir, publisherChecksOff: services.settings.snapshot().publisher_checks_off === true, entries: services.plugins.list(), panels: catalogPanels(services.catalogDefinitions()) as never, editors: catalogEditors(services.catalogDefinitions()) },
        remote: {
            host: services.remote.hostName,
            url: services.remote.url(),
            unavailable: services.remote.unavailable(),
            locked: services.remote.locked(),
            pin: services.remote.activePin(),
            devices: services.remote.devices(),
            pairRequests: services.pairing.requests(),
            connections: services.remote.connections(),
            enabled: services.settings.snapshot().remote_access === true,
            firewall: ports.firewall !== undefined,
            firewallRule: ports.firewall ? ports.firewall.rule() : null,
            firewallOutcome: state.firewallOutcome ?? null,
            tailscale: ports.tailscale ? ports.tailscale.status() : null,
            tailscaleOutcome: state.tailscaleOutcome ?? null,
            tynnWorkstation: ports.tynnWorkstation ? ports.tynnWorkstation() : null,
        },
    };
}

/** The measured machine action group; unrelated and caller-bound UI actions remain with their owner. */
export async function applyMachineFeatureAction(services: MachineFeatureServices, action: FeatureAction,
    state: FeatureState, next: FeatureState, ports: MachineFeaturePorts): Promise<boolean> {
    switch (action.kind) {
        case 'issueWatch.setRepo':
            // A Watched repos checkbox: Tynn's switch, one field; Tynn pushes the changed feed, main re-reads the switches.
            await ports.issueWatchSetRepo?.(action.workspaceId, action.owner, action.repo, {
                ...(typeof action.enabled === 'boolean' ? { enabled: action.enabled } : {}),
                ...(typeof action.includeUpstream === 'boolean' ? { includeUpstream: action.includeUpstream } : {}),
            });
            break;
        case 'issueWatch.refresh':
            // The GitHub panel's Refresh: Tynn reads the workspace's repos now and pushes what it finds.
            await ports.issueWatchRefresh?.(action.workspaceId);
            break;
        case 'remote.issuePin':
            // `replaces`: Re-pair on a device's row — the device that pairs (and is allowed) takes that one's place.
            await services.remote.issuePin(action.replaces ? { replaces: action.replaces } : {});
            break;
        case 'remote.revokeDevice':
            if (!(await services.remote.revokeDevice(action.deviceId))) throw new Error(`no device ${action.deviceId}`);
            break;
        case 'remote.lock':
            await services.remote.lock();
            break;
        case 'remote.unlock':
            await services.remote.unlock();
            break;
        case 'remote.restart':
            await ports.remoteAccess?.restart();
            break;
        case 'tailscale.up': {
            if (!ports.tailscale) throw new Error('Tailscale is not available here');
            const r = await ports.tailscale.up();
            next.tailscaleOutcome = r.ok ? 'Connected to your tailnet.' : r.authUrl ? 'Tailscale needs you to sign in: the sign-in page opened in your browser.' : (r.message ?? 'Tailscale could not connect.');
            break;
        }
        // Each mutation goes through Windows' prompt and reads the rule again before answering.
        case 'remote.allowFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            const r = await ports.firewall.allow();
            await ports.firewall.refresh();
            next.firewallOutcome = r.ok ? 'Allowed: devices on your tailnet can reach this port.' : r.cancelled ? 'Cancelled: Windows asked, and nothing was changed.' : (r.error ?? 'The firewall rule could not be added.');
            break;
        }
        case 'remote.removeFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            const r = await ports.firewall.remove();
            await ports.firewall.refresh();
            next.firewallOutcome = r.ok
                ? 'Removed: Windows Firewall no longer lets devices on your tailnet reach this port.'
                : r.cancelled ? 'Cancelled: Windows asked, and nothing was changed.'
                // netsh failed, and Windows now has no such rule: someone removed it first; say that, not "failed".
                : ports.firewall.rule()?.state === 'absent' ? `Windows has no rule named “${FIREWALL_RULE_NAME}” now: there is nothing to remove.`
                : (r.error ?? 'The firewall rule could not be removed.');
            break;
        }
        // TYNN SIGN-IN, the way Genie 1 did it: open Tynn in the browser, take the code back, Sign out revokes the key.
        case 'integrations.tynnSignIn': {
            // NO KEYRING: no trip to Tynn for a sign-in that could not be kept. The keyring card says why, and its button
            // is the next step (the owner, 2026-11-01).
            if (ports.keyring?.view()) { next.tynnSignInUrl = null; next.tynnMessage = null; break; }
            const { url } = await tynnAccountOf(ports).startSignIn();
            next.tynnSignInUrl = url;
            next.tynnMessage = null;
            break;
        }
        // THE KEYRING CARD'S ONE BUTTON: install, start, restart or check again, whichever the session needs next.
        case 'keyring.fix': {
            if (!ports.keyring) throw new Error('this Genie has no keyring to set up here');
            // Answered once the step is done, or the keyring's own unlock dialog is up (it waits on the person, not on this).
            await (ports.keyring.press ? ports.keyring.press() : ports.keyring.fix());
            break;
        }
        // THE CARD'S CANCEL while the keyring's unlock dialog is up (Tynn story #388).
        case 'keyring.cancel': {
            await ports.keyring?.cancel?.();
            break;
        }
        case 'integrations.tynnCode': {
            const r = await tynnAccountOf(ports).signIn(action.code);
            if (r.ok) { next.tynnSignInUrl = null; next.tynnMessage = null; } else next.tynnMessage = r.reason;
            break;
        }
        case 'integrations.tynnSignOut': {
            const r = await tynnAccountOf(ports).signOut();
            next.tynnSignInUrl = null;
            next.tynnMessage = r.revoked ? null : r.reason;
            break;
        }
        // GITHUB, Genie 1's way (beta.33 item 25): one button starts the device flow (the code comes back in the snapshot and
        // the account waits for GitHub by itself, pushing when it lands); the pages are the account's own URLs.
        case 'integrations.githubSignIn':
            await githubAccountOf(ports).startSignIn();
            break;
        case 'integrations.githubCancelSignIn':
            githubAccountOf(ports).cancelSignIn();
            break;
        case 'integrations.githubRefresh':
            await githubAccountOf(ports).refresh();
            break;
        case 'integrations.githubSignOut':
            await githubAccountOf(ports).signOut();
            break;
        case 'plugins.setEnabled':
            // ADF B8: a change the host refuses is a failure the page shows, with Retry; never dropped.
            if (!(await services.plugins.setEnabled(action.id, action.enabled))) throw new Error(`${action.id} could not be ${action.enabled ? 'enabled' : 'disabled'}: it is not an installable plugin here`);
            break;
        case 'plugins.setNetworkAllowed':
            if (!(await services.plugins.setNetworkAllowed(action.id, action.allowed))) throw new Error(`${action.id}: its network can only be allowed or blocked while it is an Unverified plugin here`);
            break;
        default: return false;
    }
    return true;
}
