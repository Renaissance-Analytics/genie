import type { LocalProtocolDoor } from './local-protocol-door.js';
import type { HostFeaturePresentation } from './features-host.js';

/** Only a live admitted connection may ask this process for its narrow UI effects. */
export function featureWindow(door: LocalProtocolDoor, ports: HostFeaturePresentation,
    browserOwner: () => number | null): (connectionId: string, method: string, args: unknown[]) => Promise<unknown> {
    return async (connectionId, method, args) => {
        const contents = door.contentsFor(connectionId);
        if (!contents) throw new Error('the caller’s own admitted local window is no longer connected');
        const browser = () => {
            if (contents.id !== browserOwner() || !ports.browser) throw new Error('this caller has no browser pane of its own');
            return ports.browser;
        };
        const perform = async (): Promise<unknown> => {
            switch (method) {
                case 'flowEditor': if (ports.openFlowEditor) return ports.openFlowEditor(String(args[0])); break;
                case 'openExternal': if (ports.openExternal) return ports.openExternal(String(args[0])); break;
                case 'openInBrowser':
                    browser(); if (ports.openInBrowser) return ports.openInBrowser(String(args[0])); break;
                case 'login': if (ports.login) return ports.login(String(args[0])); break;
                case 'rendererNotice.dismiss': if (ports.rendererNotice) return ports.rendererNotice.dismiss(); break;
                case 'mainErrors.dismiss': if (ports.mainErrors) return ports.mainErrors.dismiss(String(args[0])); break;
                case 'mainErrors.retryHostCopy': if (ports.mainErrors?.retryHostCopy) return ports.mainErrors.retryHostCopy(String(args[0])); break;
                case 'mainErrors.openLog': if (ports.mainErrors?.openLog) return ports.mainErrors.openLog(typeof args[0] === 'string' ? args[0] : undefined); break;
                case 'mainErrors.report': if (ports.mainErrors?.report) return ports.mainErrors.report(String(args[0])); break;
                case 'browser.navigate': return browser().navigate(String(args[0]));
                case 'browser.back': return browser().back();
                case 'browser.forward': return browser().forward();
                case 'browser.reload': return browser().reload();
            }
            throw new Error('this caller’s window does not provide that feature effect');
        };
        const value = await perform();
        if (door.contentsFor(connectionId) !== contents) throw new Error('the caller’s local window disconnected during its action');
        return { value: value ?? null, browser: contents.id === browserOwner() ? ports.browser?.snapshot() ?? null : null };
    };
}
