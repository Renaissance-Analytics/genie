import { describe, expect, it } from 'vitest';
import { redactPluginFsError } from '../api';

/**
 * genie #54 / CodeQL js/stack-trace-exposure — the /api/plugins/editor-* endpoints
 * return runPluginEditorFs's result to a REMOTE member. On failure that result is
 * `{ ok:false, error: String(e) }`; the raw error (a plugin fs error, possibly with
 * a path/stack) must be redacted to a fixed reason before it leaves the host.
 */
describe('redactPluginFsError', () => {
    it('replaces a failure error with a fixed, value-free reason (no raw text to remote)', () => {
        expect(
            redactPluginFsError({ ok: false, error: 'Error: ENOENT /home/genie/secret\n  at read (x)' }),
        ).toEqual({ ok: false, error: 'plugin file operation failed' });
    });

    it('passes a success result through unchanged', () => {
        expect(redactPluginFsError({ ok: true, base64: 'aGk=' })).toEqual({ ok: true, base64: 'aGk=' });
    });

    it('leaves an error-less failure alone (nothing to redact)', () => {
        expect(redactPluginFsError({ ok: false })).toEqual({ ok: false });
    });

    // Total-sanitizer contract (CodeQL #11): a branch-only redactor that redacts the
    // failure case but `return r`s otherwise still hands the caller's object — whose
    // `.error` field carries the raw String(e) — straight to the remote response, and
    // CodeQL's path-insensitive tracker follows that passthrough to the sink. The
    // redactor must therefore NEVER return the input by reference, and the output
    // `.error` must only ever be the fixed reason or absent — never any other text.
    it('never returns the caller object by reference (no raw-error passthrough on any path)', () => {
        const ok = { ok: true, base64: 'aGk=' };
        expect(redactPluginFsError(ok)).not.toBe(ok);
        const noErr = { ok: false };
        expect(redactPluginFsError(noErr)).not.toBe(noErr);
    });

    it('strips an empty/blank error rather than passing it through', () => {
        const out = redactPluginFsError({ ok: false, error: '' });
        // Only the fixed reason or nothing — never the caller's raw (here empty) string.
        expect(out.error === undefined || out.error === 'plugin file operation failed').toBe(true);
        expect(out).toEqual({ ok: false });
    });

    it('the output error is only ever the fixed reason, for any raw failure text', () => {
        for (const raw of ['Error: ENOENT /etc/passwd', 'at Object.<anonymous> (/srv/x.js:9)', 'boom']) {
            expect(redactPluginFsError({ ok: false, error: raw }).error).toBe('plugin file operation failed');
        }
    });
});
