/**
 * THE WORKSTATION'S AMBIENT SIGNALS — what the title-bar icons used to say at a glance.
 *
 * ## Why this exists
 *
 * P7 deletes the title-bar icon row on the promise "8 icons → 0 icons, 0 features lost". The
 * FEATURES are safe: every one has a ⌘K row built from `FEATURE_SURFACES`, and a CI guard refuses
 * to let one become unreachable. What the icons also did is tell you something was happening —
 * and a palette row cannot do that:
 *
 *  - the Flows icon ANIMATED while a Flow was running on this machine
 *  - the AgentInbox icon badged when agents were behind on their mail
 *  - a warning glyph appeared when GitHub permissions were blocking features
 *  - the Genie OS icon pulsed while the OS agent was producing output
 *  - IssueWatch carried a count, and could say "cannot tell"
 *
 * Owner decision, asked directly: *"move the signals to the Deck, then delete the icons."* So they
 * live here, as a derived list, and the Deck renders them.
 *
 * ## Silence means nothing is wrong
 *
 * A signal appears only when it is TRUE. A strip of "0 waiting · no flows running · GitHub fine"
 * is furniture that trains people to stop reading it — and this surface's whole value is that
 * something appearing means something happened. That is the same rule the session model applies
 * to a rail: *"never a dash for an unknown number — a dash reads as zero"*.
 *
 * Pure, because the renderer's test environment has no DOM: a decision made inside a component is
 * a decision nobody checks.
 */

export type StationSignalId =
    | 'flows-running'
    | 'mail-behind'
    | 'github-blocked'
    | 'os-working'
    | 'issuewatch-unknown'
    | 'workstation-online';

/** How loudly a signal reads. The Deck maps this to colour; nothing else does. */
export type SignalTone = 'busy' | 'attention' | 'unknown';

export interface StationSignal {
    id: StationSignalId;
    /** What it says. Short enough to sit in a row of them. */
    label: string;
    tone: SignalTone;
    /**
     * The ⌘K feature id this signal is ABOUT, so clicking it goes somewhere useful.
     *
     * The icons were both a signal and a door. Keeping the door is what makes deleting them
     * honest — a badge you cannot act on is worse than an icon you can.
     */
    featureId: string;
}

export interface StationFacts {
    /** A Flow is executing on this machine right now. */
    flowsRunning: boolean;
    /** Messages delivered to agents that they have not received — `agentInboxLag`. */
    mailBehind: number;
    /** GitHub permissions are missing and features are disabled because of it. */
    githubBlocked: boolean;
    /** The Genie OS agent is producing output right now. */
    osWorking: boolean;
    /** IssueWatch cannot say whether this workspace is tracked. */
    issueWatchUnknown: boolean;
    /**
     * A Virtual Workstation went provisioning → online since you last looked.
     *
     * The Hosts icon GLOWED for this, and that icon is gone. Kept because it is the signal with
     * the longest wait behind it: spawning a workstation takes minutes, and without it the owner
     * re-opens the popover to catch the moment it becomes connectable. Hosts are also the feature
     * the owner called out as "super important".
     */
    workstationCameOnline: boolean;
}

/**
 * The signals worth showing, in the order they matter.
 *
 * Ordered by what a person should act on first: something BLOCKED beats something merely
 * unknown, and both beat something that is simply busy — busy is information, not a request.
 */
export function stationSignals(facts: StationFacts): StationSignal[] {
    const out: StationSignal[] = [];

    if (facts.githubBlocked) {
        out.push({
            id: 'github-blocked',
            // Says what it COSTS, not what is misconfigured: "features are disabled" is the part a
            // person can decide about.
            label: 'GitHub permissions needed — some features are off',
            tone: 'attention',
            featureId: 'github-caps',
        });
    }

    if (facts.mailBehind > 0) {
        out.push({
            id: 'mail-behind',
            label:
                facts.mailBehind === 1
                    ? '1 message waiting for an agent'
                    : `${facts.mailBehind} messages waiting for agents`,
            tone: 'attention',
            featureId: 'agent-inbox',
        });
    }

    if (facts.issueWatchUnknown) {
        out.push({
            id: 'issuewatch-unknown',
            // UNKNOWN is not a problem and must not read as one — `null` means cannot see, and
            // saying "0 issues" here would be the confident zero this codebase keeps paying for.
            label: 'IssueWatch cannot tell whether this workspace is tracked',
            tone: 'unknown',
            featureId: 'issuewatch',
        });
    }

    if (facts.workstationCameOnline) {
        out.push({
            id: 'workstation-online',
            // ATTENTION rather than busy: something finished and is now waiting to be used, which
            // is a thing to act on. Busy would read as "still working".
            label: 'A workstation came online',
            tone: 'attention',
            featureId: 'remote-host',
        });
    }

    if (facts.flowsRunning) {
        out.push({
            id: 'flows-running',
            label: 'A Flow is running',
            tone: 'busy',
            featureId: 'flows',
        });
    }

    if (facts.osWorking) {
        out.push({
            id: 'os-working',
            label: 'Genie is working',
            tone: 'busy',
            featureId: 'genie-os',
        });
    }

    return out;
}
