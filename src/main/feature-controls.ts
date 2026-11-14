import { classifyNavigation } from '../core/browser-policy.js';
import type { FeatureAction } from '../renderer/features.js';
import type { WindowServices } from './compose.js';
import type { FeaturePorts, FeatureState } from './feature-ipc.js';
import { githubAccountOf } from './feature-machine.js';

export interface FeatureControlServices {
    readonly pairing?: Pick<WindowServices['pairing'], 'answer'>;
    routes(): ReturnType<WindowServices['routes']>;
}
export interface FeatureControlPorts extends Pick<FeaturePorts, 'rendererNotice' | 'hangNotice' | 'safeMode' | 'firewall' | 'githubAccount'> {
    readonly tailscale?: Pick<NonNullable<FeaturePorts['tailscale']>, 'install'>;
    readonly githubOpen?: NonNullable<FeaturePorts['githubAccount']>['openPage'];
    readonly browser?: {
        navigate(url: string): Promise<void>;
        back(): void | Promise<void>;
        forward(): void | Promise<void>;
        reload(): void | Promise<void>;
    };
}

/** Existing host controls and browser policy. A host supplies only the caller's narrow UI effects. */
export async function applyFeatureControlAction(services: FeatureControlServices, action: FeatureAction,
    next: FeatureState, ports: FeatureControlPorts): Promise<boolean> {
    switch (action.kind) {
        case 'rendererNotice.dismiss': {
            if (!ports.rendererNotice) throw new Error('This window keeps no such notice.');
            const done = await ports.rendererNotice.dismiss();
            if (!done.ok) throw new Error(done.reason);
            break;
        }
        case 'hangNotice.dismiss':
        case 'hangNotice.stopAll': {
            if (!ports.hangNotice) throw new Error('Genie’s host is not connected.');
            const done = action.kind === 'hangNotice.dismiss' ? await ports.hangNotice.dismiss() : await ports.hangNotice.stopAll();
            if (!done.ok) throw new Error(done.reason);
            break;
        }
        case 'safeMode.leave': {
            if (!ports.safeMode) throw new Error('Genie’s host is not connected, so safe mode cannot be left from here.');
            const left = await ports.safeMode.leave();
            if (!left.ok) throw new Error(left.reason);
            break;
        }
        case 'remote.answerPair': {
            // Allow or Deny on "Pair this device?", from this machine's own window (a remote connection is refused upstream).
            if (!services.pairing) throw new Error('this Genie has no pairing owner');
            const r = await services.pairing.answer(action.id, action.allow);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'tailscale.install': {
            if (!ports.tailscale) throw new Error('Tailscale is not available here');
            const r = await ports.tailscale.install();
            next.tailscaleOutcome = r.started ? 'Tailscale’s installer is open: finish it, then Connect.' : r.url ? 'Tailscale’s download page opened in your browser.' : (r.message ?? 'Tailscale could not be installed from here.');
            break;
        }
        // The page opened, or its window regained focus: read Windows again, debounced.
        case 'remote.readFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            await ports.firewall.reread();
            break;
        }
        case 'integrations.githubOpen':
            await (ports.githubOpen ? ports.githubOpen(action.target) : githubAccountOf(ports).openPage(action.target));
            break;
        case 'browser.navigate': {
            const nav = classifyNavigation(action.url, services.routes());
            if (nav.kind === 'refused') throw new Error(nav.reason);
            // A site is its own https origin, path kept (core/browser-policy.ts); a name nobody serves is shown at its root.
            next.browserUrl = nav.kind === 'no-site' ? `https://${nav.host}/` : nav.url;
            await ports.browser?.navigate(next.browserUrl);
            break;
        }
        // Back, forward and reload act on the pane's own history in main (main.ts); the URL they land on comes back from
        // the view's navigation report, never guessed here.
        case 'browser.back':
        case 'browser.forward':
        case 'browser.reload':
            if (action.kind === 'browser.back') await ports.browser?.back();
            if (action.kind === 'browser.forward') await ports.browser?.forward();
            if (action.kind === 'browser.reload') await ports.browser?.reload();
            break;
        default: return false;
    }
    return true;
}
