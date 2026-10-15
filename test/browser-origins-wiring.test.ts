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
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('the pane’s session (electron-browser-view.ts)', () => {
    it('routes with the PAC from core — ses.setProxy(genProxyConfig(<front door port>)) — once', () => {
        expect(count(view, /ses\.setProxy\(genProxyConfig\(options\.frontDoorPort\)\)/g)).toBe(1);
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
        expect(count(main, /electronBrowserView\(window, \{ frontDoorPort: composed\.frontDoorPort, caPem: browserTrust\.caPem \}\)/g)).toBe(1);
    });

    it('main applies back / forward / reload to the pane, and pushes what the pane reports', () => {
        expect(count(main, /action\.kind === 'browser\.(back|forward|reload)'\) browserPane\?\.(back|forward|reload)\(\)/g)).toBe(3);
        expect(count(main, /browserPane\.onChange\(/g)).toBe(1);
    });

    it('compose opens Genie’s CA ONCE for both doors, and the in-app door is given a TLS context for its tunnel', () => {
        expect(count(compose, /GenCa\.open\(/g)).toBe(1);
        expect(compose).toMatch(/new GenRouterServer\(routes, \{\s*tls: \(host\) =>/);
    });
});
