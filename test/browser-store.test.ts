import { join, relative, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserStorePath, guardWebviewAttach, type WebviewPrefs } from '../src/core/browser-store.js';

/**
 * WHERE A WORKSPACE'S LOGINS LIVE, AND WHAT A <webview> MAY BE (the host split, P2b; the owner, 2026-11-03: "can we keep
 * cookies in .genie/browser/{workspace}/*"). One store per workspace per process, under Genie's home and never a repo: a
 * login must not sit where it could be committed. Measured on Electron 45.2.2: with no guard a renderer's chosen preload
 * ran, a file:// src loaded and another partition was accepted, so main decides all of it.
 */

const home = join('/home/a', '.genie');

describe('browserStorePath', () => {
    it('one folder per workspace, per process, under Genie\u2019s home', () => {
        expect(browserStorePath(home, 'ws_123', 'window')).toBe(join(home, 'browser', 'ws_123', 'window'));
        expect(browserStorePath(home, 'ws_123', 'browser')).toBe(join(home, 'browser', 'ws_123', 'browser'));
    });

    it('two workspaces never share a folder, and neither do the two processes', () => {
        const paths = new Set([browserStorePath(home, 'a', 'window'), browserStorePath(home, 'b', 'window'), browserStorePath(home, 'a', 'browser')]);
        expect(paths.size).toBe(3);
    });

    it.each(['..', '.', '../other', 'a/b', 'a\\b', '', 'C:\\x', 'a b'])('an id that could leave the folder is refused: %j', (id) => {
        expect(() => browserStorePath(home, id, 'window')).toThrow(/workspace id/);
    });

    it('never inside a workspace: the result stays under the home whatever the id', () => {
        const rel = relative(home, browserStorePath(home, 'ws-1.a_b', 'browser'));
        expect(rel.startsWith('..') || isAbsolute(rel)).toBe(false);
    });
});

describe('guardWebviewAttach', () => {
    const allowed = { enabledHosts: () => ['moic.gen', 'shop.gen'] };
    const attach = (src: string, prefs: WebviewPrefs = {}) => guardWebviewAttach(src, prefs, allowed);

    it('an enabled .gen site over https: allowed, with its host named for the session', () => {
        expect(attach('https://moic.gen/').allow).toEqual(true);
        expect(attach('https://MOIC.gen/deep/page?x=1')).toMatchObject({ allow: true, host: 'moic.gen' });
    });

    it.each([
        ['a file', 'file:///etc/passwd'],
        ['the app itself', 'file:///C:/Genie/resources/app/index.html'],
        ['plain http', 'http://moic.gen/'],
        ['a site not enabled', 'https://other.gen/'],
        ['the open web', 'https://example.com/'],
        ['a name that only contains one', 'https://moic.gen.example.com/'],
        ['credentials in front', 'https://moic.gen@example.com/'],
        ['a data URL', 'data:text/html,hi'],
        ['javascript', 'javascript:alert(1)'],
        ['nothing', ''],
        ['not a URL', 'moic.gen'],
    ])('%s is refused', (_name, src) => {
        expect(attach(src).allow).toBe(false);
    });

    it('whatever the renderer asked for, the guest gets none of it', () => {
        const prefs: WebviewPrefs = {
            preload: 'file:///evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true, nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: true,
            contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true, partition: 'persist:someone-elses',
            experimentalFeatures: true, enableBlinkFeatures: 'x', webviewTag: true,
        };
        expect(attach('https://moic.gen/', prefs).allow).toBe(true);
        expect(prefs).toEqual({ nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false });
    });

    it('refused or allowed, nothing the renderer set survives: a refusal leaves the prefs hardened too', () => {
        const prefs: WebviewPrefs = { preload: 'file:///evil.js', nodeIntegration: true };
        expect(attach('file:///x', prefs).allow).toBe(false);
        expect(prefs.preload).toBeUndefined();
        expect(prefs.nodeIntegration).toBe(false);
    });
});
