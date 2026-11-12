import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { servedPath } from '../src/main/gapp-server.js';

/**
 * AN APP'S FILE IS A FILE OF ITS OWN FOLDER BEFORE ANYTHING ON DISK IS ASKED (CodeQL alert #106). The request's path is
 * joined under the app's folder and checked to stay there, by its text alone, before the first lstat or realpath; the
 * realpath check after it still refuses a link that leads out. (A normal file and a link out: test/gapps-v4-serving.test.ts.)
 */
const DIR = resolve('/srv', 'apps', 'notes');

describe('servedPath', () => {
    it('a file of the folder, joined under it', () => {
        expect(servedPath(DIR, ['app', 'index.html'])).toBe(join(DIR, 'app', 'index.html'));
    });

    it('a path that leaves the folder, or is the folder itself, is nothing to serve', () => {
        expect(servedPath(DIR, ['..', 'other', 'secret.txt'])).toBeNull();
        expect(servedPath(DIR, ['app', '..', '..', 'x'])).toBeNull();
        expect(servedPath(DIR, [])).toBeNull();
        expect(servedPath(DIR, ['.'])).toBeNull();
    });

    it('CONTROL: a file deeper in the folder is served from where it is', () => {
        expect(servedPath(DIR, ['app', 'assets', 'app.js'])).toBe(join(DIR, 'app', 'assets', 'app.js'));
    });
});

describe('the server asks the disk only about a path that passed', () => {
    it('the request handler takes its file from servedPath, before its first lstat, realpath or readFile', () => {
        const src = readFileSync('src/main/gapp-server.ts', 'utf8');
        const handler = src.slice(src.indexOf('async #onRequest('), src.indexOf('#onUpgrade('));
        const checked = handler.indexOf('servedPath(served.dir, segments)');
        expect(checked).toBeGreaterThan(-1);
        for (const fs of ['lstat(', 'realpath(', 'readFile(']) expect(handler.indexOf(fs), fs).toBeGreaterThan(checked);
        expect(handler).not.toMatch(/join\(served\.dir/);
    });
});
