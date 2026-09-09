import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every alert goes through the SAME gate, and every kind has something that
 * fires it (genie#546).
 *
 * SOURCE-LEVEL, like `agent-verbs-wiring.test.ts` next door and for the same
 * reason: what is being pinned is the presence or absence of a CALL SITE.
 * `background.ts` bootstraps Electron on import so there is no cheap behavioural
 * harness for it, and a behavioural test can only exercise the call sites that
 * exist — while the failure mode here is somebody adding a kind and wiring
 * nothing to it, or removing the wiring from one that had it.
 *
 * The kinds with a testable seam are covered behaviourally elsewhere:
 *   - processExit / failure  → main/terminal/__tests__/process-exit-alert.test.ts
 *   - flowRun / failure      → main/flows/__tests__/flow-run-alert.test.ts
 *   - agentMessage /
 *     automatedNotice        → main/agentinbox/__tests__/message-alert.test.ts
 *   - reviewRequest          → main/plugins/__tests__/review-alert.test.ts
 *
 * This file covers the two that only `background.ts` can answer for, and the
 * whole-set property none of them can: that no kind was left unfired.
 */

const mainDir = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(mainDir, rel), 'utf8');

/**
 * Which module fires each kind. A kind with no entry is the thing this file
 * exists to catch: a settings row that changes nothing, which reads to a user as
 * a broken feature rather than as an unbuilt one.
 */
const FIRED_BY: Record<string, string[]> = {
    imDone: ['background.ts', 'remote/index.ts'],
    forceQuestion: ['ask/force-question.ts'],
    agentMessage: ['agentinbox/presence.ts'],
    automatedNotice: ['agentinbox/presence.ts'],
    flowRun: ['flows/index.ts'],
    reviewRequest: ['plugins/registry.ts'],
    processExit: ['terminal/process-supervisor.ts'],
    failure: ['flows/index.ts', 'terminal/process-supervisor.ts'],
};

describe('no kind is a dead control', () => {
    it('names a firing site for every kind in the registry', async () => {
        const { ALERT_KINDS } = await import('../notify-sound-kinds');
        expect(Object.keys(FIRED_BY).sort()).toEqual([...ALERT_KINDS].sort());
    });

    it('each named site really does raise an alert', () => {
        // The map above is a claim; this is the check. A module listed here that
        // stopped firing alerts would otherwise leave the claim standing.
        //
        // Two sanctioned ways to raise one: `playAlert` / `playAlertSound` for a
        // renderer on THIS machine, and `alertSoundPayload` for `remote/index.ts`,
        // which puts the alert on the wire to a driver's window instead of into
        // one of its own.
        const seen = new Set(Object.values(FIRED_BY).flat());
        for (const file of seen) {
            const src = read(file);
            expect(src, `${file} raises no alert`).toMatch(
                /playAlert(Sound)?\(|alertSoundPayload\(/,
            );
        }
    });
});

describe('the two kinds that predate the registry now share the one gate', () => {
    it('imDone fires through playAlertSound, and still decides the toast sound', () => {
        const src = read('background.ts');
        expect(src).toContain("playAlertSound('imDone'");
        // The OS toast is silenced only when OUR chime actually played, so the
        // two do not double up — and an alert set to None still lets the OS make
        // its own sound. That decision reads the return value.
        expect(src).toContain('silent: playedSound');
    });

    it('ForceTheQuestion fires through playAlertSound', () => {
        const src = read('ask/force-question.ts');
        expect(src).toContain("playAlertSound('forceQuestion'");
    });

    it('neither call site resolves and delivers the chime by hand any more', () => {
        // POSITIVE CONTROL for the two above: importing `playAlertSound` proves
        // nothing if the old resolve-then-deliver sequence is still sitting
        // beside it, firing a second time.
        for (const file of ['background.ts', 'ask/force-question.ts']) {
            const src = read(file);
            expect(src, `${file} still resolves the sound itself`).not.toContain(
                'resolveAlertSound(',
            );
        }
    });
});

describe('the modules with no window of their own can still fire', () => {
    it('background.ts registers where playAlert finds the master window', () => {
        const src = read('background.ts');
        expect(src).toContain('setAlertSoundWindowSource(');
        expect(src).toContain('masterWindow');
    });
});

describe('a remote driver gets the motif too', () => {
    it('builds its notify:sound payload from alertSoundPayload', () => {
        // A remote window plays the chime in ITS renderer, so it needs the same
        // payload a local one gets. Hand-writing `{ kind: 'imDone', sound }`
        // there is how the host and the client end up disagreeing about which
        // chime an alert means.
        const src = read('remote/index.ts');
        expect(src).toContain('alertSoundPayload(');
    });
});
