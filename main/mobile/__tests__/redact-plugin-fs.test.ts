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
});
