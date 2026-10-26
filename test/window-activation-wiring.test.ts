import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * NO WINDOW TAKES FOCUS EXCEPT FROM A GESTURE (genie#1235) — the Electron half, read from source. The rule itself is
 * core/window-activation.ts (window-activation.test.ts); this holds that main calls it, and nothing else, to put a window
 * in front: every raw focus()/show()/restore() in src/main is a way round the rule. Line comments stripped (CRLF-safe).
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const code = (path: string): string => strip(readFileSync(new URL(path, import.meta.url), 'utf8'));
const mainDir = new URL('../src/main/', import.meta.url);
const sources = readdirSync(mainDir).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: strip(readFileSync(new URL(f, mainDir), 'utf8')) }));
const main = code('../src/main/main.ts');

describe('no raw activation anywhere in src/main', () => {
    it('no window.focus() / restore() / moveTop() / app.focus() — only bringUp may (core/window-activation.ts)', () => {
        // The process book's restore() is not a window's; it is the only other `.restore()` in src/main.
        const found = sources.flatMap(({ file, text }) => (text.match(/\b[\w!.]+\.(focus|restore|moveTop)\(\)|\bapp\.focus\(/g) ?? []).filter((m) => m !== 'processBook.restore()').map((m) => `${file}: ${m}`));
        expect(found).toEqual([]);
    });

    it('no window.show() — a Notification’s n.show() is a toast, and doctor mode’s window is the launch the person asked for', () => {
        const found = sources.flatMap(({ file, text }) => (text.match(/\b[\w!.]+\.show\(\)/g) ?? []).filter((m) => m !== 'n.show()').map((m) => `${file}: ${m}`));
        expect(found).toEqual(['doctor.ts: win.show()']);
    });

    it('the question window still opens inactive, and is the only always-on-top window', () => {
        const q = code('../src/main/question-window-electron.ts');
        expect(q).toMatch(/win\.once\('ready-to-show', \(\) => win\.showInactive\(\)\)/);
        expect(sources.filter(({ text }) => /setAlwaysOnTop\(/.test(text)).map(({ file }) => file)).toEqual(['question-window-electron.ts']);
    });
});

describe('the paths an agent or a job can reach are BACKGROUND', () => {
    it('openFileForUser navigates and never reveals the main window (the owner’s report: an agent took the keyboard)', () => {
        const openFile = /openFile: async \(\{ workspaceId, path, line \}\) => \{([^\n]*)\}/.exec(main)?.[1] ?? '';
        expect(openFile).toMatch(/broadcast\('genie:navigate', openFileRoute\(workspaceId, path, line\)\)/);
        expect(openFile).not.toMatch(/revealMainWindow/);
        expect(openFile).toMatch(/attractMainWindow\('openFileForUser'\)/);
    });

    it('an agent’s `sites open` opens the Genie browser in the background; the Hosting row’s Open is the person’s', () => {
        expect(main).toMatch(/openInBrowserFor\('background'\)/);
        expect(main).toMatch(/openInBrowserFor\('user-gesture'\)/);
        // The agents' tools get the background one; the feature ports (the Hosting tab's buttons) the person's.
        expect(main).toMatch(/hosting: composed,\s*openInBrowser: openInBrowserFor\('background'\),/);
        expect(main).toMatch(/\.\.\.processPorts\(\),\s*openInBrowser: openInBrowserFor\('user-gesture'\),/);
    });

    it('a page in a site panel opening a window (window.open, a script, an agent driving the page) is background', () => {
        const panels = code('../src/main/site-panels-electron.ts');
        expect(panels).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*options\.openInWindow\(url, 'background'\);/);
        // Read raw: the line holds `https://`, which the comment strip would cut.
        const raw = readFileSync(new URL('../src/main/site-panels-electron.ts', import.meta.url), 'utf8');
        expect(raw).toMatch(/'site-panel:open-window'[^\n]*options\.openInWindow\(`https:\/\/\$\{key\(host\)\}\/`, 'user-gesture'\)/);
    });

    it('the Genie browser window shows and re-raises through the rule, with the caller’s activation', () => {
        const browser = code('../src/main/genie-browser-electron.ts');
        expect(browser).toMatch(/window\.once\('ready-to-show', \(\) => showWhenReady\(window, \{ activation, /);
        expect(browser).toMatch(/bringUp\(entry!\.win, \{ activation, /);
        // The caller says which: `open(address, activation, remote)` has no default to fall back on.
        expect(browser).toMatch(/open\(address: string \| undefined, activation: Activation, remote\?: RemoteBrowsing\)/);
    });
});

describe('every main-process activation names its gesture', () => {
    it('revealMainWindow takes a reason and is the user-gesture path; it is never handed over bare', () => {
        expect(main).toMatch(/function revealMainWindow\(reason: string\): void \{\s*if \(!window\) return;\s*bringUp\(window, \{ activation: 'user-gesture', reason/);
        expect(main.match(/[(,:]\s*revealMainWindow\s*[,)]/g) ?? []).toEqual([]);
    });

    it('take-over, files, main and remote windows are shown through showWhenReady, with the opener’s activation', () => {
        expect(main.match(/win\.once\('ready-to-show', \(\) => showWhenReady\(win, (request|\{ activation)/g) ?? []).toHaveLength(3);
        expect(main).toMatch(/function openTakeOverWindow\(route: string, activation: Activation\): void/);
        expect(main).toMatch(/function openFilesWindow\(route: string, activation: Activation\): void/);
    });

    it('THE DIAGNOSTIC: every window that takes focus is logged with the request that came before it', () => {
        expect(main).toMatch(/app\.on\('browser-window-focus', \(_event, focused\) => \{[^}]*activationLedger\.explain\(windowLabelOf\(focused\.webContents\.getURL\(\)\), Date\.now\(\)\)/);
    });
});
