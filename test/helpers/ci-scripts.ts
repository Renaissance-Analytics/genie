import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GENIE'S CI, AS THE TESTS READ IT (Tynn #692). The gate is scripts/ci/linux.sh (omarchy-test) and scripts/ci/windows.ps1
 * (an Azure Windows VM); GitHub runs no tests. Tests that held a contract on a ci.yml step hold it here, on the row that
 * runs it. Comments are stripped by line first: a command named in a comment is not a command.
 *
 * Read by PATH from the repo root, never `new URL(…, import.meta.url)`: a happy-dom test file that imports this
 * (test/gapps-595-open.test.tsx) gets happy-dom's `URL`, and the read became test/helpers/undefined (ENOENT; the 62a gate).
 * test/smoke-rail-measure.test.tsx reads the same way.
 */
const read = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

export const linuxSh = code(read('scripts/ci/linux.sh'));
export const windowsPs1 = code(read('scripts/ci/windows.ps1'));

/** The rows each script runs, in order: linux.sh's ROWS=( … ), windows.ps1's $Rows = @( … ). */
export const linuxRows: string[] = (/\nROWS=\(([^)]*)\)/.exec(linuxSh)?.[1] ?? '').split(/\s+/).filter(Boolean);
export const windowsRows: string[] = [...(/\n\$Rows = @\(([^)]*)\)/.exec(windowsPs1)?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);

/** A row's own body: `row_<name>() { … }` in linux.sh (to the next line that is exactly `}` or the next one-line row). */
export function linuxRow(name: string): string {
    const start = linuxSh.search(new RegExp(`\\nrow_${name.replace(/[-]/g, '[-]')}\\(\\) \\{`));
    if (start < 0) return '';
    const rest = linuxSh.slice(start + 1);
    const firstLine = rest.slice(0, rest.indexOf('\n'));
    if (/\}\s*$/.test(firstLine)) return firstLine;
    return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

/**
 * A function's body in windows.ps1: `function <name> { … }`, or one with parameters (`function Run([string]$what, …) {`),
 * to its closing brace at the start of a line. Only the bare form was found, so `windowsFunction('Run')` read '' (62a gate).
 */
export function windowsFunction(name: string): string {
    const start = windowsPs1.search(new RegExp(`\\nfunction ${name.replace(/[-]/g, '[-]')}(?: \\{|\\()`));
    if (start < 0) return '';
    const rest = windowsPs1.slice(start + 1);
    const firstLine = rest.slice(0, rest.indexOf('\n'));
    if (/\}\s*$/.test(firstLine)) return firstLine;
    return rest.slice(0, rest.indexOf('\n}\n') + 2);
}
