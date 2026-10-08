import { describe, expect, it } from 'vitest';
import { stationSignals, type StationFacts } from '../station-signals';

/**
 * THE SIGNALS THE ICONS CARRIED, after the icons are gone.
 *
 * P7's "8 icons → 0 icons, 0 features lost" is true of features — every one has a ⌘K row and a CI
 * guard protects it — and was NOT true of signals. The icons also animated, badged and warned, and
 * a palette row cannot. Owner decision, asked directly: *"move the signals to the Deck, then delete
 * the icons."*
 *
 * The rule under test is the one that makes a signal strip worth reading at all: **it is silent
 * unless something is true.** A row of reassurances is furniture, and furniture trains people to
 * stop looking — at which point the one time it matters, nobody sees it.
 */

const quiet: StationFacts = {
    flowsRunning: false,
    mailBehind: 0,
    githubBlocked: false,
    osWorking: false,
    issueWatchUnknown: false,
};

describe('stationSignals', () => {
    it('says NOTHING when nothing is happening', () => {
        // Not "all clear", not five green ticks. Nothing.
        expect(stationSignals(quiet)).toEqual([]);
    });

    it('reports a running Flow, which is what the icon animated for', () => {
        const signals = stationSignals({ ...quiet, flowsRunning: true });
        expect(signals).toHaveLength(1);
        expect(signals[0]!.id).toBe('flows-running');
        expect(signals[0]!.tone).toBe('busy');
    });

    it('reports mail agents have not picked up, and COUNTS it', () => {
        // The badge was a number. "Some messages" would lose the thing that tells you whether one
        // agent is briefly behind or the whole rig has stopped reading.
        expect(stationSignals({ ...quiet, mailBehind: 4 })[0]!.label).toContain('4');
        expect(stationSignals({ ...quiet, mailBehind: 1 })[0]!.label).toBe(
            '1 message waiting for an agent',
        );
    });

    it('says what GitHub permissions COST, not that they are misconfigured', () => {
        const signal = stationSignals({ ...quiet, githubBlocked: true })[0]!;
        expect(signal.label).toContain('features are off');
        expect(signal.tone).toBe('attention');
    });

    it('marks an UNKNOWN as unknown, never as a problem', () => {
        // `null` means cannot see. Rendering it as attention would make a question look like a
        // fault, which is the confident-zero mistake this codebase keeps paying for.
        expect(stationSignals({ ...quiet, issueWatchUnknown: true })[0]!.tone).toBe('unknown');
    });

    it('reports the OS agent working, which is what that icon pulsed for', () => {
        expect(stationSignals({ ...quiet, osWorking: true })[0]!.id).toBe('os-working');
    });

    it('puts what is BLOCKED before what is unknown, and both before what is merely busy', () => {
        // Ordered by what to act on first. Busy is information, not a request.
        const signals = stationSignals({
            flowsRunning: true,
            mailBehind: 2,
            githubBlocked: true,
            osWorking: true,
            issueWatchUnknown: true,
        });
        expect(signals.map((s) => s.id)).toEqual([
            'github-blocked',
            'mail-behind',
            'issuewatch-unknown',
            'flows-running',
            'os-working',
        ]);
    });

    it('carries the FEATURE each signal is about, so it is still a door', () => {
        // The icons were a signal AND a way in. Keeping the door is what makes deleting them
        // honest: a badge you cannot act on is worse than an icon you can.
        const ids = stationSignals({
            flowsRunning: true,
            mailBehind: 1,
            githubBlocked: true,
            osWorking: true,
            issueWatchUnknown: true,
        }).map((s) => s.featureId);
        expect(ids).toEqual(['github-caps', 'agent-inbox', 'issuewatch', 'flows', 'genie-os']);
    });

    it('never invents a signal from a NEGATIVE count', () => {
        // `agentInboxLag` is a count from a push event. A negative one is a bug upstream, and
        // rendering "−1 messages waiting" would make this surface the place it shows up.
        expect(stationSignals({ ...quiet, mailBehind: -1 })).toEqual([]);
    });
});
