import { describe, expect, it } from 'vitest';
import { isFatalElectronLine } from '../launch';

/**
 * THE RENDERER TELLS US WHY IT DIED, AND NOBODY IS LISTENING — genie#667, seven occurrences.
 *
 * The minidump's exception stream settles what kind of crash this is, without symbols:
 *
 * ```
 * exception_code  : 5   -> SIGTRAP
 * exception_flags : 128 -> SI_KERNEL
 * exception_address: 0x0
 * ```
 *
 * `SIGTRAP` + `SI_KERNEL` + a null fault address is a **deliberate trap** — Chromium's
 * `IMMEDIATE_CRASH()`, which is what a failed `CHECK()` or an explicit `FATAL` emits. Not a memory
 * error, and **not** a glibc abort: `__libc_fatal` raises `SIGABRT` (6), and this is 5. (An earlier
 * comment of mine inferred `pthread_create` failing from a `glibc: pthread` fragment on the stack.
 * That was wrong — the fragment was stack garbage, and a string on a stack deserves less weight than
 * I gave it.)
 *
 * **A Chromium CHECK prints its reason before dying**: `[FATAL:file.cc(123)] Check failed: <expr>`,
 * naming the exact check, file and line. That is the end of the investigation rather than a step in
 * it — and grepping the crashing run for `FATAL`, `Check failed`, `DCHECK` and `Received signal`
 * found **nothing**, because the rig never captured the renderer's stderr. The one line that
 * identifies the cause is written and discarded on every occurrence.
 *
 * ## Why a FILTER rather than piping everything
 *
 * Electron is chatty — Fontconfig, libva, GPU, dbus, ALSA. Thirty spec files of that is a log nobody
 * reads, which is the same failure the release-notes limit exists to prevent. So the predicate is
 * the part worth testing: **a filter that drops the one line that matters is worse than no filter**,
 * because it looks like the capture is working.
 */

describe('isFatalElectronLine — what must be kept', () => {
    it('keeps a Chromium CHECK, which is the whole reason this exists', () => {
        expect(
            isFatalElectronLine('[0708/130023.123456:FATAL:render_frame_impl.cc(1234)] Check failed: !frame_->IsDetached().'),
        ).toBe(true);
    });

    it('keeps a bare FATAL line even without the Check failed clause', () => {
        expect(isFatalElectronLine('[FATAL:v8_initializer.cc(99)] Fatal javascript OOM in GC')).toBe(true);
    });

    it('keeps DCHECK, which fires in a debug-ish build and names the same thing', () => {
        expect(isFatalElectronLine('[1234:5678:0708/130023:DCHECK:node.cc(42)] Check failed: ok')).toBe(true);
    });

    it('keeps the signal report Chromium writes on a trap', () => {
        expect(isFatalElectronLine('Received signal 5 SIGTRAP 000000000000')).toBe(true);
    });

    it('keeps an explicit renderer-crash note', () => {
        expect(isFatalElectronLine('[ERROR:gpu_process_host.cc(993)] GPU process exited unexpectedly: exit_code=133')).toBe(true);
    });
});

describe('isFatalElectronLine — what must be dropped, or the log is unreadable', () => {
    const noise = [
        'Fontconfig warning: "/etc/fonts/fonts.conf", line 100: unknown element "blank"',
        'libva error: vaGetDriverNameByIndex() failed with unknown libva error',
        '[1:1:0708/130020:WARNING:sandbox_linux.cc(430)] InitializeSandbox() called with multiple threads',
        'ALSA lib confmisc.c:767:(parse_card) cannot find card \'0\'',
        'MESA-LOADER: failed to open swrast',
        '',
        '   ',
    ];

    it('drops ordinary Electron chatter', () => {
        for (const line of noise) {
            expect(isFatalElectronLine(line), line).toBe(false);
        }
    });

    it('drops a WARNING even when it mentions a check-like word', () => {
        // Specifically guarded: `WARNING` lines are frequent and sometimes contain "failed". Keeping
        // them would flood the log and bury the FATAL this exists to surface.
        expect(isFatalElectronLine('[WARNING:audio_manager.cc(10)] Failed to open device')).toBe(false);
    });

    it('is not fooled by the word fatal inside ordinary prose', () => {
        // A filter matching /fatal/i anywhere would keep this, and the CI log already contains the
        // line "# NON-FATAL. azure.archive.ubuntu.com has now been unreachable twice".
        expect(isFatalElectronLine('# NON-FATAL. azure.archive.ubuntu.com has now been unreachable twice')).toBe(false);
    });
});

describe('the launch path captures it', () => {
    const src = require('node:fs')
        .readFileSync(require('node:path').resolve(__dirname, '../launch.ts'), 'utf8')
        .replace(/\r\n/g, '\n');

    it('subscribes to the Electron process stderr', () => {
        expect(src).toContain("app.process().stderr");
    });

    it('filters it through the tested predicate rather than inlining a regex', () => {
        expect(src).toContain('isFatalElectronLine(');
    });

    it('REPORTS whether the capture is live, so silence is unambiguous', () => {
        /**
         * The first version logged nothing when `app.process().stderr` was null, and `if (stderr)`
         * skips silently — so "zero FATAL lines" could mean *nothing fatal happened* or *the capture
         * was inert*, and the first CI run could not tell me which. That is the `null` vs `none`
         * rule this codebase states everywhere, broken inside a diagnostic whose entire job is to
         * make an absence meaningful.
         */
        expect(src).toContain('electron stderr: ${stderr ? ');
        expect(src).toContain('NOT AVAILABLE');
    });

    it('ENABLES Chromium logging, or there is nothing to capture', () => {
        /**
         * Occurrence 8 crashed the renderer with the capture confirmed `attached` and produced ZERO
         * lines. Chromium's logging — where `[FATAL:…] Check failed:` goes — is off unless enabled,
         * so the sentence that names the crash was never emitted on any of the eight occurrences.
         * The capture and the sink are two halves of one mechanism, and a working capture over a
         * silent sink looks exactly like a healthy run.
         */
        expect(src).toContain("'--enable-logging'");
    });

    it('positive control: the guard reads the real file', () => {
        expect(src).toContain('export async function launchGenieE2E');
        expect(src).not.toContain('isFatalElectronLineThatDoesNotExist');
    });
});
