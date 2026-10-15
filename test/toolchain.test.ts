import { describe, expect, it } from 'vitest';
import {
    HOST_TOOLS,
    compareVersions,
    parseVersionOutput,
    planUpdate,
    repairOutcome,
    toolStatus,
    type ToolProbe,
} from '../src/core/toolchain.js';

/**
 * THE MANAGED TOOLCHAIN (§6.6) — the pure half: what is installed, whether something newer
 * exists, how an update would be performed on this platform, and HONEST REPAIR — Genie never
 * claims a fix it did not make. The owner's hybrid decision carries over: host tools are
 * update-to-latest with a badge; multi-version lives with service engines, not on PATH.
 */

describe('the tools Genie manages', () => {
    it('are PHP, Node, Python, Go, Rust plus the tools the stack rides on — each with its probe', () => {
        const names = HOST_TOOLS.map((t) => t.name);
        for (const n of ['php', 'node', 'npm', 'python', 'go', 'rustc', 'cargo', 'git', 'composer']) expect(names).toContain(n);
        for (const t of HOST_TOOLS) {
            expect(t.probe.args).toContain('--version');
            expect(t.probe.binary.length).toBeGreaterThan(0);
        }
    });
});

describe('reading a version out of a tool’s own output', () => {
    it('parses each tool’s real banner', () => {
        const cases: Array<[string, string, string]> = [
            ['php', 'PHP 8.4.11 (cli) (built: Aug 27 2026 11:31:08) (ZTS Visual C++ 2022 x64)', '8.4.11'],
            ['node', 'v22.23.2', '22.23.2'],
            ['npm', '11.6.1', '11.6.1'],
            ['python', 'Python 3.13.7', '3.13.7'],
            ['go', 'go version go1.25.1 windows/amd64', '1.25.1'],
            ['rustc', 'rustc 1.90.0 (1159e78c4 2026-09-14)', '1.90.0'],
            ['cargo', 'cargo 1.90.0 (840b83a10 2026-07-30)', '1.90.0'],
            ['git', 'git version 2.51.0.windows.1', '2.51.0'],
            ['composer', 'Composer version 2.8.12 2026-09-19 13:41:59', '2.8.12'],
        ];
        for (const [tool, out, want] of cases) expect(parseVersionOutput(tool, out), tool).toBe(want);
    });

    it('output with no version in it is null, never an invented 0.0.0', () => {
        expect(parseVersionOutput('php', "'php' is not recognized as an internal or external command")).toBeNull();
        expect(parseVersionOutput('node', '')).toBeNull();
    });
});

describe('comparing versions', () => {
    it('numeric, segment-wise; a missing segment is zero; pre-release loses to its release', () => {
        expect(compareVersions('8.4.11', '8.4.9')).toBeGreaterThan(0);
        expect(compareVersions('22.23.2', '22.23.2')).toBe(0);
        expect(compareVersions('1.25', '1.25.0')).toBe(0);
        expect(compareVersions('2.0.0-beta.5', '2.0.0')).toBeLessThan(0);
        expect(compareVersions('10.0.0', '9.9.9')).toBeGreaterThan(0);
    });
});

describe('a tool’s status — installed, latest, and an HONEST badge', () => {
    const probe = (over: Partial<ToolProbe>): ToolProbe => ({ tool: 'node', installed: '22.23.2', latest: '22.24.0', source: 'nodejs.org index', ...over });

    it('update-available when a trusted source names something newer', () => {
        expect(toolStatus(probe({}))).toEqual({ tool: 'node', installed: '22.23.2', latest: '22.24.0', tone: 'update-available', source: 'nodejs.org index' });
    });

    it('up-to-date when installed is the latest', () => {
        expect(toolStatus(probe({ latest: '22.23.2' })).tone).toBe('up-to-date');
        // Installed NEWER than the index knows (a nightly) is also not an update.
        expect(toolStatus(probe({ latest: '22.22.0' })).tone).toBe('up-to-date');
    });

    it('UNKNOWN when no source could name a latest — never "up-to-date" by default', () => {
        const s = toolStatus(probe({ latest: null, source: null }));
        expect(s.tone).toBe('unknown');
        expect(s.latest).toBeNull();
    });

    it('not-installed when there is no installed version, whatever the index says', () => {
        expect(toolStatus(probe({ installed: null })).tone).toBe('not-installed');
    });
});

describe('planning an update for THIS platform — Genie builds the command from its own tables', () => {
    it('Windows → winget; macOS → brew; Debian → apt; Fedora → dnf; agent TUIs → npm -g everywhere', () => {
        expect(planUpdate({ tool: 'git', platform: 'win32', packageManager: 'winget' })).toEqual({ command: 'winget upgrade --id Git.Git --silent --accept-package-agreements --accept-source-agreements', manager: 'winget' });
        expect(planUpdate({ tool: 'git', platform: 'darwin', packageManager: 'brew' })).toEqual({ command: 'brew upgrade git', manager: 'brew' });
        // pkexec, not sudo: Genie runs commands with no terminal, so sudo could never ask for the password.
        expect(planUpdate({ tool: 'git', platform: 'linux', packageManager: 'apt' })).toEqual({ command: 'pkexec apt-get install --only-upgrade -y git', manager: 'apt' });
        expect(planUpdate({ tool: 'git', platform: 'linux', packageManager: 'dnf' })).toEqual({ command: 'pkexec dnf upgrade -y git', manager: 'dnf' });
        expect(planUpdate({ tool: 'claude-code', platform: 'linux', packageManager: 'apt' })).toEqual({ command: 'npm install -g @anthropic-ai/claude-code@latest', manager: 'npm' });
    });

    it('a tool this manager does not know, or a manager that cannot update it, is a refusal with the reason — not a guessed command', () => {
        expect(planUpdate({ tool: 'frobnicate', platform: 'linux', packageManager: 'apt' })).toEqual({ refused: 'frobnicate is not a tool Genie manages' });
        expect(planUpdate({ tool: 'rustc', platform: 'win32', packageManager: 'winget' })).toEqual({ command: 'rustup update stable', manager: 'rustup' });
        expect(planUpdate({ tool: 'git', platform: 'linux', packageManager: null })).toEqual({ refused: 'no package manager found on this machine to update git with' });
    });
});

describe('HONEST REPAIR — never claim a fix that was not made', () => {
    it('a repair is judged by the version measured AFTER, not by the command exiting 0', () => {
        expect(repairOutcome({ tool: 'node', wanted: '22.24.0', before: '22.23.2', after: '22.24.0', exitCode: 0 })).toEqual({ kind: 'repaired', from: '22.23.2', to: '22.24.0' });
        // Exit 0, nothing changed: the manager said yes and did nothing — the common winget case.
        expect(repairOutcome({ tool: 'node', wanted: '22.24.0', before: '22.23.2', after: '22.23.2', exitCode: 0 })).toEqual({ kind: 'unchanged', installed: '22.23.2', reason: 'the update command exited 0 but node still reports 22.23.2; nothing was changed' });
        // Non-zero exit, but the version moved: report what is true, with the exit code noted.
        expect(repairOutcome({ tool: 'node', wanted: '22.24.0', before: '22.23.2', after: '22.24.0', exitCode: 1 })).toEqual({ kind: 'repaired', from: '22.23.2', to: '22.24.0', note: 'the command exited 1 but node now reports 22.24.0' });
    });

    it('a tool that was not re-measurable afterwards is `unverified`, never `repaired`', () => {
        expect(repairOutcome({ tool: 'php', wanted: '8.4.12', before: '8.4.11', after: null, exitCode: 0 })).toEqual({ kind: 'unverified', reason: 'php could not be probed after the update; the result is unknown' });
    });

    it('a version that moved but not to what was wanted says so', () => {
        expect(repairOutcome({ tool: 'node', wanted: '22.24.0', before: '22.23.2', after: '22.23.5', exitCode: 0 })).toEqual({ kind: 'repaired', from: '22.23.2', to: '22.23.5', note: 'wanted 22.24.0; the manager installed 22.23.5' });
    });
});
