import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * S7'S ELECTRON WIRING, READ FROM SOURCE — the adapter (`electron-browser-view.ts`) and main.ts are Electron-only, so
 * their few load-bearing lines are checked here; the rules they apply are tested in browser-origins / browser-trust /
 * gen-router-tunnel. Line comments are stripped line by line (CRLF-safe); every pattern is one no JSDoc here contains. Counted.
 */

const code = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');

const view = code('../src/main/electron-browser-view.ts');
const main = code('../src/main/main.ts');
const compose = code('../src/main/compose.ts');
// Genie's hosting (the CA, both front doors) is built here: by genie-host, or by the window with no host (P5a).
const hosting = code('../src/main/hosting-compose.ts');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('the pane’s session (electron-browser-view.ts)', () => {
    it('routes with the PAC from core — ses.setProxy(genProxyConfig(<front door port>)) — once', () => {
        expect(count(view, /ses\.setProxy\(genProxyConfig\(port\)\)/g)).toBe(1);
        // At the port NOW, and again when the front door moved (P5a.2: genie-host can come back on another port).
        expect(view).toMatch(/let routedPort = options\.frontDoorPort\(\);\s*let routed = route\(routedPort\);/);
        expect(view).toMatch(/following\.add\(\(\) => \{ const port = options\.frontDoorPort\(\); if \(port !== routedPort\) \{ routedPort = port; routed = route\(port\); \} \}\);/);
    });

    it('sets its certificate check once, answering ONLY with the verifier’s verdict — no literal 0 / -2 / -3 anywhere', () => {
        expect(count(view, /ses\.setCertificateVerifyProc\(/g)).toBe(1);
        expect(count(view, /callback\(verify\(\{ hostname: request\.hostname, certificatePem: request\.certificate\.data \}\)\)/g)).toBe(1);
        expect(count(view, /callback\(\s*-?\d+\s*\)/g)).toBe(0);
    });

    it('is the pane’s own partition — never the app’s default session — and the Host rewrite is gone', () => {
        expect(count(view, /session\.fromPartition\('persist:genie-browser'\)/g)).toBe(1);
        expect(count(view, /defaultSession/g)).toBe(0);
        expect(count(view, /onBeforeSendHeaders/g)).toBe(0);
    });

    it('a page load waits for the routing (a .gen load before it would go to DNS)', () => {
        expect(view).toMatch(/loadURL: async \(url\) => \{\s*await routed;\s*await view\.webContents\.loadURL\(url\);/);
    });
});

describe('main and compose', () => {
    it('main hands the pane the in-app front door’s port and Genie’s CA — once', () => {
        // Through mountMainWindow (P1b: the main window can be built again), from boot's front door and CA.
        expect(count(main, /electronBrowserView\(window, \{ frontDoorPort: deps\.frontDoorPort, caPem: deps\.caPem \}\)/g)).toBe(1);
        expect(count(main, /mainWindowDeps = \{ frontDoorPort: \(\) => frontDoorNow\.port, caPem: \(\) => frontDoorNow\.caPem,/g)).toBe(1);
        // The front door as it is now, as genie-host's frontdoor.watch says it (Tynn #1046), and every browser session told
        // when it moves (P5a.2).
        expect(count(main, /frontDoorNow = frontDoorWatch\.now\(\);/g)).toBe(1);
        // With P2b: the panes and every session and workspace store in this process (rerouteGenieBrowserSession) follow. The
        // Genie browser's own process hears the door from genie-host itself (Tynn #1046 D2), so nothing here republishes.
        expect(main).toMatch(/frontDoorWatch\.onChange\(\(view, moved\) => \{[\s\S]{0,700}?followFrontDoorInPanes\(\);\s*rerouteGenieBrowserSession\(\{ frontDoorPort: view\.port, caPem: view\.caPem \}\);/);
        const onChange = main.slice(main.indexOf('frontDoorWatch.onChange((view, moved) => {'), main.indexOf('frontDoorWatch.onChange((view, moved) => {') + 900);
        expect(onChange.slice(0, onChange.indexOf('\n    });'))).not.toMatch(/publishBrowserFacts/);
        // A store or session made after the door moved uses the door it moved to, not its creator's port.
        const gbe = readFileSync(new URL('../src/main/genie-browser-electron.ts', import.meta.url), 'utf8');
        expect(gbe).toMatch(/export function rerouteGenieBrowserSession\(options: \{[^}]*\}\): void \{\s*currentPort = options\.frontDoorPort;/);
        expect(count(gbe, /routeSession\(ses, currentPort \?\? options\.frontDoorPort, /g)).toBe(2);
        // The browser's facts and the cookie bridge's stores carry the CA as it is now.
        // The site panels are made with the front door genie-host said at boot (frontDoorNow, after the watch is ready).
        expect(count(main, /frontDoorPort: frontDoorNow\.port, caPem: frontDoorNow\.caPem, enabledHosts:/g)).toBe(1);
        expect(main).not.toMatch(/browserTrust/);
    });

    it('the admitted caller applies back / forward / reload to its own pane, and pushes what the pane reports', () => {
        const effects = code('../src/main/feature-window.ts');
        for (const method of ['back', 'forward', 'reload']) {
            expect(effects).toContain(`case 'browser.${method}': return browser().${method}();`);
            expect(count(main, new RegExp(`${method}: \\(\\) => browserPane\\?\\.${method}\\(\\)`, 'g'))).toBe(1);
        }
        expect(effects).toContain('const contents = door.contentsFor(connectionId);');
        expect(effects).toContain("if (contents.id !== browserOwner() || !ports.browser) throw new Error('this caller has no browser pane of its own');");
        expect(count(main, /browserPane\.onChange\(/g)).toBe(1);
    });

    it('Genie’s hosting opens Genie’s CA ONCE for both doors, and the in-app door is given a TLS context for its tunnel', () => {
        expect(count(hosting, /GenCa\.open\(/g)).toBe(1);
        // compose opens none of its own: it builds its hosting through hosting-compose.ts, or is handed the host's.
        expect(count(compose, /GenCa\.open\(/g)).toBe(0);
        expect(hosting).toMatch(/new GenRouterServer\(routes, \{\s*tls: \(host\) =>/);
    });
});
