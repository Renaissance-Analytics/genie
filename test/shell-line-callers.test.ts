import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LoginHost } from '../src/main/login-host.js';

const scratch = mkdtempSync(join(tmpdir(), 'genie-shell-line-login-'));

/** What goes into a shell line: every caller named, and what a sign-in's line may hold. */
function host(binary: string | null) {
    const opened: string[] = [];
    const logins = new LoginHost({
        terminals: { open: ((options: { command?: string }) => { opened.push(options.command ?? ''); return { id: `t${opened.length}`, pid: 1, shell: 'cmd', scrollback: '' }; }) as never, onExit: (() => () => {}) as never },
        openWindow: () => {},
        runStatus: vi.fn(async () => 1),
        onSignedIn: () => {},
        binaryFor: () => binary,
        // P7: the login's scratch is the caller's; one made here, never the OS temp folder by default.
        scratch: () => scratch,
    });
    return { logins, opened };
}

describe('a provider sign-in: the resolved path goes inside double quotes, so nothing in it may leave them', () => {
    it.each([
        ['a quote that closes them', 'C:\\tools" & calc & "'],
        ['a line break', 'C:\\tools\nclaude'],
        ['a carriage return', 'C:\\tools\rclaude'],
        ['a variable cmd expands inside quotes', 'C:\\%COMSPEC%\\claude.exe'],
        ['a substitution a POSIX shell runs inside quotes', '/opt/$(touch /tmp/x)/claude'],
        ['the older substitution', '/opt/`touch /tmp/x`/claude'],
        ['a backslash at the end, which eats the closing quote', '/opt/claude\\'],
    ])('%s: refused, and no terminal opens', (_, binary) => {
        const { logins, opened } = host(binary);
        const started = logins.start('claude');
        expect(started.ok).toBe(false);
        expect(opened).toEqual([]);
    });

    it.each([
        ['a Windows path with spaces', 'C:\\Program Files\\Claude\\claude.exe', '"C:\\Program Files\\Claude\\claude.exe" auth login'],
        ['a POSIX path', '/usr/local/bin/claude', '"/usr/local/bin/claude" auth login'],
        ['no override: the CLI on PATH, and no quote at all', null, 'claude auth login'],
    ])('CONTROL: %s runs', (_, binary, line) => {
        const { logins, opened } = host(binary);
        expect(logins.start('claude').ok).toBe(true);
        expect(opened).toEqual([line]);
    });
});

describe('a provider sign-in: an unknown provider is the line itself, so it must be a plain name', () => {
    it.each([['x & calc'], ['x"y'], ['a;b'], ['$(touch /tmp/x)'], ['a b'], ['a|b'], ['']])('%j: refused, and no terminal opens', (provider) => {
        const { logins, opened } = host(null);
        expect(logins.start(provider).ok).toBe(false);
        expect(opened).toEqual([]);
    });

    it('CONTROL: a plain name opens its own CLI', () => {
        const { logins, opened } = host(null);
        expect(logins.start('gemini').ok).toBe(true);
        expect(opened).toEqual(['gemini']);
    });
});

describe('who can ask for a shell line at all', () => {
    const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = `${dir}/${name}`; return statSync(join(dir, name)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []; });

    it('these, each decided on. A new one fails here until someone has read what reaches it', () => {
        const callers = walk('src/main').filter((file) => /\bshell: true\b/.test(code(file))).sort();
        expect(callers).toEqual([
            // A held login's account (Tynn #699): the same status line, from login-host's statusCommandFor (checked path).
            'src/main/genie-host.ts',
            // Constant lines and a checked path (above).
            'src/main/login-host.ts',
            // The status line beside it, through Node's own shell: true.
            'src/main/main.ts',
            // An agent's `command`. It is a shell line on purpose, and the person approves that text.
            'src/main/mcp-tools-more.ts',
            // Passes on what it was asked.
            'src/main/terminal-host.ts',
        ]);
    });

    it("an agent's command: what the person approves is the same text that runs, with nothing between", () => {
        const source = code('src/main/mcp-tools-more.ts');
        const from = source.indexOf('const command = str(args.command);');
        const to = source.indexOf('command, shell: true', from);
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        const between = source.slice(from, to);
        expect(between).toContain("deps.approve(caller, 'create', command ?? '(a shell)', context)");
        expect(between).not.toMatch(/(?<!const )\bcommand\s*=[^=]/);
    });

    it("a remote client's and a window's terminal ask for no shell: the line is split into an argv, and no shell reads it", () => {
        const api = code('src/main/host-api.ts');
        const open = api.slice(api.indexOf("case 'terminals.open': {"), api.indexOf("case 'terminals.write':"));
        expect(open).toContain('openReady');
        expect(open).not.toContain('shell');
    });
});
