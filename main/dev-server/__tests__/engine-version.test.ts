import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseNvmrc,
    parseToolVersions,
    parseGoMod,
    parseComposerPhp,
    detectDeclaredEngines,
    engineMajor,
    describeEngineMismatch,
    stackToEngine,
    hostEngineProbe,
} from '../engine-version';

/**
 * Engine-version selection (goal item 4), interim approach (owner's call): DETECT
 * the version a repo declares, VALIDATE it against the host's installed version,
 * and WARN on a mismatch. Host-native engines (php/node/go) run on the HOST, so
 * Genie can't silently switch them — a clear "this repo wants node 22, your host
 * has 20" is the actionable thing. Pure parsers + a major-version compare.
 */

function tmp(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-engver-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return root;
}

describe('pure parsers', () => {
    it('parseNvmrc strips a leading v and trailing whitespace', () => {
        expect(parseNvmrc('v22.1.0\n')).toBe('22.1.0');
        expect(parseNvmrc('20')).toBe('20');
        expect(parseNvmrc('  \n')).toBeUndefined();
    });

    it('parseToolVersions maps each declared tool to its version', () => {
        expect(parseToolVersions('nodejs 22.1.0\nphp 8.4.3\n# a comment\npython 3.12')).toEqual({
            nodejs: '22.1.0',
            php: '8.4.3',
            python: '3.12',
        });
    });

    it('parseGoMod reads the go directive', () => {
        expect(parseGoMod('module x\n\ngo 1.22\n\nrequire (\n)\n')).toBe('1.22');
        expect(parseGoMod('module x\n')).toBeUndefined();
    });

    it('parseComposerPhp reads config.platform.php, else require.php', () => {
        expect(parseComposerPhp(JSON.stringify({ config: { platform: { php: '8.3.0' } } }))).toBe('8.3.0');
        expect(parseComposerPhp(JSON.stringify({ require: { php: '^8.2' } }))).toBe('^8.2');
        expect(parseComposerPhp('not json')).toBeUndefined();
    });
});

describe('detectDeclaredEngines', () => {
    it('reads node from .nvmrc, php from composer, go from go.mod', () => {
        const root = tmp({
            '.nvmrc': 'v22\n',
            'composer.json': JSON.stringify({ require: { php: '^8.2' } }),
            'go.mod': 'module x\ngo 1.21\n',
        });
        expect(detectDeclaredEngines(root)).toEqual({ node: '22', php: '^8.2', go: '1.21' });
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('.tool-versions covers every engine, and package.json engines.node is a node source', () => {
        const tv = tmp({ '.tool-versions': 'nodejs 20.11.0\nphp 8.1\n' });
        expect(detectDeclaredEngines(tv)).toMatchObject({ node: '20.11.0', php: '8.1' });
        const pkg = tmp({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }) });
        expect(detectDeclaredEngines(pkg).node).toBe('>=18');
        fs.rmSync(tv, { recursive: true, force: true });
        fs.rmSync(pkg, { recursive: true, force: true });
    });

    it('is empty for a repo that declares nothing', () => {
        const root = tmp({ 'readme.md': 'hi' });
        expect(detectDeclaredEngines(root)).toEqual({});
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('engineMajor + describeEngineMismatch', () => {
    it('engineMajor extracts the first version number from a bare version or a range', () => {
        expect(engineMajor('22.1.0')).toBe(22);
        expect(engineMajor('v20')).toBe(20);
        expect(engineMajor('^8.2')).toBe(8);
        expect(engineMajor('>=18.0.0')).toBe(18);
        expect(engineMajor('stable')).toBeNull();
    });

    it('stackToEngine maps a host runtime stack to its engine, else null', () => {
        expect(stackToEngine('php')).toBe('php');
        expect(stackToEngine('node')).toBe('node');
        expect(stackToEngine('go')).toBe('go');
        expect(stackToEngine('static')).toBeNull();
        expect(stackToEngine('rust')).toBeNull();
        expect(stackToEngine(undefined)).toBeNull();
    });

    it('hostEngineProbe pulls the version out of each engine’s --version output', () => {
        expect(hostEngineProbe('node').parse('v22.1.0\n')).toBe('22.1.0');
        expect(hostEngineProbe('php').parse('8.4.3')).toBe('8.4.3');
        expect(hostEngineProbe('go').parse('go version go1.22.1 darwin/arm64')).toBe('1.22.1');
        expect(hostEngineProbe('python').parse('Python 3.12.0\n')).toBe('3.12.0');
    });

    it('warns ONLY when the host major differs from the declared major', () => {
        expect(describeEngineMismatch('node', '22', 'v20.11.0')).toMatch(/node/);
        expect(describeEngineMismatch('node', '22', 'v20.11.0')).toMatch(/22/);
        expect(describeEngineMismatch('node', '22', 'v20.11.0')).toMatch(/20/);
        // Same major → no warning.
        expect(describeEngineMismatch('node', '22', 'v22.5.1')).toBeNull();
        // Host version unknown (not installed / not probed) → warn it's declared but absent.
        expect(describeEngineMismatch('php', '8.3', null)).toMatch(/8\.3/);
        // Nothing declared, or unparseable → no warning.
        expect(describeEngineMismatch('go', 'stable', '1.22')).toBeNull();
    });
});
