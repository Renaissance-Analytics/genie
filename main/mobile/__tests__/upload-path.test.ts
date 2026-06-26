import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    resolveAiUploadPath,
    uploadPathCandidates,
    MAX_UPLOAD_BYTES,
} from '../api';

/**
 * The mobile `.ai/` upload writes a phone-supplied filename into a workspace's
 * `.ai/` dir. The path-traversal guard is the only thing standing between a
 * hostile client and an arbitrary-write; these drive it directly (pure, no fs).
 */

const WS = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
// Uploads land in the unorganized inbox <ws>/.ai/_dirty.
const AI = path.resolve(WS, '.ai', '_dirty');

function ok(r: ReturnType<typeof resolveAiUploadPath>) {
    if ('error' in r) throw new Error(`expected ok, got error: ${r.error}`);
    return r;
}

describe('resolveAiUploadPath (path-traversal guard)', () => {
    it('accepts a plain filename and lands it in <ws>/.ai', () => {
        const r = ok(resolveAiUploadPath(WS, 'notes.md'));
        expect(r.safeName).toBe('notes.md');
        expect(r.aiDir).toBe(AI);
        expect(r.filePath).toBe(path.join(AI, 'notes.md'));
        // The resolved file stays strictly inside .ai.
        expect(path.relative(AI, r.filePath).startsWith('..')).toBe(false);
    });

    it('strips directory components, keeping only the basename', () => {
        const r = ok(resolveAiUploadPath(WS, 'sub/dir/file.txt'));
        expect(r.safeName).toBe('file.txt');
        expect(r.filePath).toBe(path.join(AI, 'file.txt'));
    });

    it('rejects POSIX traversal (../../etc/passwd)', () => {
        const r = resolveAiUploadPath(WS, '../../etc/passwd');
        // basename is `passwd` → it never escapes; still must resolve inside .ai.
        if ('error' in r) {
            expect(r.error).toBeTruthy();
        } else {
            expect(r.filePath).toBe(path.join(AI, 'passwd'));
            expect(path.relative(AI, r.filePath).startsWith('..')).toBe(false);
        }
    });

    it('rejects a bare `..`', () => {
        expect(resolveAiUploadPath(WS, '..')).toEqual({ error: 'invalid filename' });
        expect(resolveAiUploadPath(WS, '.')).toEqual({ error: 'invalid filename' });
    });

    it('rejects a Windows backslash-traversal', () => {
        const r = resolveAiUploadPath(WS, '..\\..\\Windows\\System32\\evil.dll');
        if ('error' in r) {
            expect(r.error).toBeTruthy();
        } else {
            expect(r.safeName).toBe('evil.dll');
            expect(path.relative(AI, r.filePath).startsWith('..')).toBe(false);
        }
    });

    it('strips a drive-letter prefix (C:evil.txt → evil.txt)', () => {
        const r = ok(resolveAiUploadPath(WS, 'C:evil.txt'));
        expect(r.safeName).toBe('evil.txt');
        expect(path.relative(AI, r.filePath).startsWith('..')).toBe(false);
    });

    it('rejects a NUL byte in the name', () => {
        expect(resolveAiUploadPath(WS, 'a\0b.txt')).toEqual({ error: 'invalid filename' });
    });

    it('rejects an empty / missing name', () => {
        expect(resolveAiUploadPath(WS, '')).toEqual({ error: 'missing filename' });
        // @ts-expect-error — exercising the runtime guard against a non-string.
        expect(resolveAiUploadPath(WS, undefined)).toEqual({ error: 'missing filename' });
    });

    it('never resolves outside .ai for any input', () => {
        const hostile = [
            '../secret',
            '../../secret',
            'foo/../../../bar',
            '/etc/shadow',
            '\\\\server\\share\\x',
            'a/b/c/../../../../../../d',
        ];
        for (const name of hostile) {
            const r = resolveAiUploadPath(WS, name);
            if ('error' in r) continue; // rejected outright — fine
            const rel = path.relative(AI, r.filePath);
            expect(rel === '' || rel.startsWith('..') || path.isAbsolute(rel)).toBe(false);
        }
    });

    it('exposes a 25 MiB decoded size cap', () => {
        expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    });
});

describe('uploadPathCandidates (collision dedupe)', () => {
    it('yields the bare name first, then suffixed variants', () => {
        const c = uploadPathCandidates(AI, 'doc.md');
        expect(c[0]).toBe(path.join(AI, 'doc.md'));
        expect(c[1]).toBe(path.join(AI, 'doc (1).md'));
        expect(c[2]).toBe(path.join(AI, 'doc (2).md'));
    });

    it('keeps the extension when suffixing', () => {
        const c = uploadPathCandidates(AI, 'archive.tar.gz');
        // extname is `.gz`; the stem keeps `archive.tar`.
        expect(c[1]).toBe(path.join(AI, 'archive.tar (1).gz'));
    });

    it('handles an extensionless name', () => {
        const c = uploadPathCandidates(AI, 'README');
        expect(c[0]).toBe(path.join(AI, 'README'));
        expect(c[1]).toBe(path.join(AI, 'README (1)'));
    });
});
