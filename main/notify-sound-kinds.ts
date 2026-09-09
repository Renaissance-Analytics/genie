/**
 * WHICH events get a sound, and what each one is called everywhere — the single
 * list (genie#546).
 *
 * ## Why this file exists rather than one more `else` branch
 *
 * Per-alert sounds shipped with exactly two kinds, and two was not a starting
 * point — it was the shape. `notify-sound.ts` resolved a kind with an if/else
 * over `imDone` and everything-else; `settings.tsx` hand-wrote one row per kind;
 * `db.ts` and `renderer/lib/genie.ts` each hand-wrote one `Settings` field per
 * key; `setting-tiers.ts` hand-wrote one tier per key. Five lists, and the only
 * one the compiler checked was the last. A third kind meant remembering all five
 * — and the failure mode of forgetting one is not a build error, it is a control
 * that is drawn but never read, or read but never drawn.
 *
 * So the registry below is the list, everything else derives from it, and
 * `main/__tests__/notify-sound-kinds.test.ts` pins that nothing has grown a
 * second copy.
 *
 * ## PURE — deliberately
 *
 * No `electron`, no `./db`, no I/O. The RENDERER imports this (the settings page
 * builds its rows from it, and the master window reads the motif out of the
 * notify payload), so a single `import './db'` here would drag the whole main
 * process into the renderer bundle. `notify-sound.ts` is where settings are
 * read; this is only the vocabulary.
 *
 * ## Which events, and the principle that chose them
 *
 * A sound INTERRUPTS a person, so it fires when attention is genuinely needed,
 * or when something they were waiting on ended — never for routine progress.
 * That rule is what admits `failure` and `reviewRequest` and what keeps out
 * "a flow started", "an agent typed", "a file changed".
 */

/** The bundled wavs a choice can name. Must match `renderer/public/sounds/*.wav`
 *  — pinned by test against that directory, so a wav added or removed there and
 *  not here fails rather than becoming an option that plays nothing. */
export const BUNDLED_SOUNDS = [
    '3tootpipe',
    'dingdongdoink',
    'sparkle',
    'triumphant',
    'winddown',
] as const;

export type BundledSound = (typeof BUNDLED_SOUNDS)[number];

/**
 * What one alert can be set to.
 *
 *   - `off`     silent for THIS alert, even with the master switch on. This is
 *               the owner's "None", and it already existed — the defect was only
 *               that it existed for two events out of eight.
 *   - `synth`   the built-in Web Audio chime, per {@link SynthMotif}.
 *   - a wav     one of {@link BUNDLED_SOUNDS}, played from `./sounds/<name>.wav`.
 *   - `custom`  the user's own file, read main-side into a data-URL because the
 *               sandboxed renderer cannot read disk.
 */
export type SoundChoice = 'off' | 'synth' | BundledSound | 'custom';

/** The Select options for one alert row, in the order they are offered.
 *  `None` sits last: it is the escape hatch, not the headline. */
export const SOUND_CHOICES: readonly { value: SoundChoice; label: string }[] = [
    { value: 'synth', label: 'Default chime' },
    { value: '3tootpipe', label: '3 Toot Pipe' },
    { value: 'dingdongdoink', label: 'Ding Dong Doink' },
    { value: 'sparkle', label: 'Sparkle' },
    { value: 'triumphant', label: 'Triumphant' },
    { value: 'winddown', label: 'Wind Down' },
    { value: 'custom', label: 'Custom file…' },
    { value: 'off', label: 'None' },
];

/**
 * Which built-in chime a kind synthesizes.
 *
 *   - `done`      a gentle rising two-note figure — "the thing you were waiting
 *                 on ended".
 *   - `attention` a fast triple-knock on a brighter triangle wave — "someone
 *                 needs you NOW".
 *
 * Deliberately TWO, not eight. Both already exist in the renderer; inventing six
 * more motifs would be six pieces of untestable audio design, and eight chimes
 * nobody can tell apart is worse for the listener than two they can.
 */
export type SynthMotif = 'done' | 'attention';

/** One alert kind, and every name it has. */
export interface AlertKindDef {
    /** The settings key holding the choice. */
    setting: string;
    /** The settings key holding the custom file path. Always `${setting}_custom`. */
    custom: string;
    /** What the choice is when the user has never touched it. */
    fallback: SoundChoice;
    /** The `kind` string that rides the `notify:sound` payload. Crosses the
     *  remote bridge between Genie versions, so these are frozen once shipped. */
    wire: string;
    /** Which built-in chime `synth` plays. */
    motif: SynthMotif;
    /** The settings row label. */
    label: string;
    /** The settings row description — says what actually fires it, because a
     *  control whose trigger you cannot guess is a control you will not use. */
    desc: string;
    /** Extra terms the settings search matches on. */
    keywords: string;
}

/**
 * THE LIST.
 *
 * `imDone` and `forceQuestion` keep their shipped settings keys and their
 * shipped wire names — a user who chose Wind Down for imDone hears Wind Down
 * after upgrading, and an older remote client still picks the right motif.
 *
 * Every new kind defaults to `off`. `notify_sound` was switched on when it meant
 * two events; six more firing on upgrade spends a consent that was never given
 * for them. Silence is recoverable in one click, and being interrupted is not.
 */
export const ALERT_SOUND_KINDS = {
    imDone: {
        setting: 'sound_imdone',
        custom: 'sound_imdone_custom',
        fallback: 'synth',
        wire: 'imDone',
        motif: 'done',
        label: 'Agent finishes — imDone',
        desc: 'An agent finished its turn or handed work back.',
        keywords: 'imdone done finished agent complete handback',
    },
    forceQuestion: {
        setting: 'sound_forcequestion',
        custom: 'sound_forcequestion_custom',
        fallback: 'synth',
        wire: 'force-question',
        motif: 'attention',
        label: 'Agent asks a question',
        desc: 'An agent raised a ForceTheQuestion and is blocked on your answer.',
        keywords: 'question forcethequestion ftq ask blocked decision',
    },
    agentMessage: {
        setting: 'sound_agentmessage',
        custom: 'sound_agentmessage_custom',
        fallback: 'off',
        wire: 'agent-message',
        motif: 'done',
        label: 'An agent messages another agent',
        desc: 'One agent sent another a message through AgentInbox. Your own messages never chime.',
        keywords: 'agentinbox agent message dm inbox talking peers',
    },
    automatedNotice: {
        setting: 'sound_automatednotice',
        custom: 'sound_automatednotice_custom',
        fallback: 'off',
        wire: 'automated-notice',
        motif: 'done',
        label: 'A machine reports in',
        desc: 'Genie itself, or a cron / watched process, posted a notice to an agent rather than a person.',
        keywords: 'cron webhook script scheduled job automated system notice machine',
    },
    flowRun: {
        setting: 'sound_flowrun',
        custom: 'sound_flowrun_custom',
        fallback: 'off',
        wire: 'flow-run',
        motif: 'done',
        label: 'A Flow finishes',
        desc: 'A Flow ran to completion. A Flow that failed or was refused chimes as a failure instead.',
        keywords: 'flow flows automation run finished completed',
    },
    reviewRequest: {
        setting: 'sound_reviewrequest',
        custom: 'sound_reviewrequest_custom',
        fallback: 'off',
        wire: 'review-request',
        motif: 'attention',
        label: 'Something is waiting for your review',
        desc: 'An agent posted to the ArtBoard and is waiting for you to approve or reject it.',
        keywords: 'artboard review approve reject post mockup verdict waiting',
    },
    processExit: {
        setting: 'sound_processexit',
        custom: 'sound_processexit_custom',
        fallback: 'off',
        wire: 'process-exit',
        motif: 'done',
        label: 'A background process ends',
        desc: 'A supervised process stopped. One that crashed chimes as a failure instead.',
        keywords: 'process background service exit stopped ended supervised',
    },
    failure: {
        setting: 'sound_failure',
        custom: 'sound_failure_custom',
        fallback: 'off',
        wire: 'failure',
        motif: 'attention',
        label: 'Something failed',
        desc: 'A background process crashed or gave up restarting, or a Flow errored or was refused.',
        keywords: 'failure failed crash error broken refused died',
    },
    /**
     * ONE kind for all three `thumbsUp` reasons — and the loudest control here,
     * which is why its description says so out loud.
     *
     * TWO of the three reasons are broadcast-and-answer, not one-off, so a thumb
     * arrives once PER AGENT:
     *
     *   - `boot` — every agent is told to call it after a (re)start, by
     *     `agents/relaunch-prompt.ts`, `agents/upgrade-guide.ts`,
     *     `agents/os-lifecycle.ts`, and the MCP guide's own orientation.
     *   - `shutdown` — `AgentShutdownReadiness.begin()` prompts every live agent
     *     and each answers, inside one 30-second window; the upgrade drain
     *     (`agents/drain.ts`) does the same before an upgrade.
     *
     * So a Genie upgrade with N registered agents is N thumbs, a restart, then N
     * more. `ack` — one agent acknowledging one peer — is the only reason that is
     * a single discrete event.
     *
     * Splitting by reason was considered and rejected: it would buy three rows of
     * which two are still bursts, and the owner asked for thumbsUp as ONE signal.
     * Defaulting to `off` is what makes that safe — nobody hears the burst
     * without choosing it, having been told what a restart sounds like.
     */
    thumbsUp: {
        setting: 'sound_thumbsup',
        custom: 'sound_thumbsup_custom',
        fallback: 'off',
        wire: 'thumbs-up',
        motif: 'done',
        label: 'Agent signals ready — thumbsUp',
        desc: 'An agent acknowledged: it booted, answered a peer, or is ready for Genie to stop. Note `boot` fires on EVERY agent start, so a Genie restart chimes once per agent.',
        keywords: 'thumbsup ready boot ack acknowledge shutdown readiness',
    },
} as const satisfies Record<string, AlertKindDef>;

/** Every alert kind Genie can chime for. DERIVED — never restate it as a union. */
export type AlertKind = keyof typeof ALERT_SOUND_KINDS;

/**
 * The kinds, in the order the settings page lists them.
 *
 * Not alphabetical and not arbitrary: the two that already shipped come first,
 * because they are the rows an existing user is looking for and moving them
 * would make the page feel rearranged rather than extended. Then the three the
 * owner named, then the three inferred from the same rule. Registry insertion
 * order IS this order — there is no second list to keep in step.
 */
export const ALERT_KINDS = Object.keys(ALERT_SOUND_KINDS) as readonly AlertKind[];

/** One kind's definition. */
export function alertKindDef<K extends AlertKind>(kind: K): (typeof ALERT_SOUND_KINDS)[K] {
    return ALERT_SOUND_KINDS[kind];
}

/** Every `sound_*` choice key. */
export type SoundSettingKey = (typeof ALERT_SOUND_KINDS)[AlertKind]['setting'];
/** Every `sound_*_custom` path key. */
export type SoundCustomSettingKey = (typeof ALERT_SOUND_KINDS)[AlertKind]['custom'];

/**
 * The sound half of the settings shape, intersected into `Settings` in both
 * `main/db.ts` and `renderer/lib/genie.ts` — so adding a kind adds its two keys
 * with no edit in either, and the two copies of `Settings` cannot disagree about
 * what a sound key is.
 *
 * Same device as `ProviderSettingKeys` in `main/agents/registry.ts`, for the
 * same reason it exists there.
 */
export type SoundSettingKeys = {
    [K in SoundSettingKey]?: SoundChoice;
} & {
    [K in SoundCustomSettingKey]?: string;
};

/**
 * The default value of every sound setting, for `getAllSettings`.
 *
 * `db.ts` used to write these four out by hand; a kind added without its two
 * lines got `undefined` where a `SoundChoice` was expected, and resolved to the
 * built-in chime whatever the registry said its default was.
 */
export function soundSettingDefaults(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kind of ALERT_KINDS) {
        const def = alertKindDef(kind);
        out[def.setting] = def.fallback;
        out[def.custom] = '';
    }
    return out;
}

/** Both keys for every kind, for the places that must enumerate them — the db
 *  defaults, the settings-tier table, the settings search index. */
export function soundSettingKeys(): Array<{
    kind: AlertKind;
    choice: SoundSettingKey;
    custom: SoundCustomSettingKey;
}> {
    return ALERT_KINDS.map((kind) => {
        const def = alertKindDef(kind);
        return { kind, choice: def.setting, custom: def.custom };
    });
}

/** Wire name → the kind that owns it, for reading a `notify:sound` payload back. */
const BY_WIRE: ReadonlyMap<string, AlertKind> = new Map(
    ALERT_KINDS.map((kind) => [alertKindDef(kind).wire, kind]),
);

/**
 * Which chime a `notify:sound` payload asks for.
 *
 * The payload carries `motif` explicitly, because the renderer must not have to
 * know the registry to play the right sound. But a payload can arrive from an
 * OLDER host over the remote bridge, carrying only the pre-#545 `kind` — so the
 * wire name is the fallback, and an unknown one is the gentle `done` figure
 * rather than the urgent knock. Getting that backwards would make an older
 * host's every imDone sound like an emergency.
 */
export function motifForPayload(payload: {
    kind?: string;
    motif?: string;
}): SynthMotif {
    if (payload.motif === 'attention' || payload.motif === 'done') return payload.motif;
    const kind = payload.kind ? BY_WIRE.get(payload.kind) : undefined;
    return kind ? alertKindDef(kind).motif : 'done';
}

/**
 * Which alert an AgentInbox message is — or null for no chime at all.
 *
 * `isMachine` is the caller's answer to "did a machine send this", and it is a
 * PARAMETER rather than something read out of `from` here on purpose. genie#543
 * made `readMachineSender` the one place that parses a machine sender id, saying
 * in as many words that a second reader is how two answers to the same question
 * start disagreeing. An earlier draft of this function tested
 * `from.startsWith('genie:')` and did disagree, on exactly the case that reader
 * documents: an unrecognised `genie:<kind>:<id>` is deliberately NOT a machine
 * source, because a kind this build has no behaviour for is not one it can act
 * on. So the format stays in the agentinbox module and this stays pure.
 *
 * The human is silent: you do not need a chime for the message you just typed.
 */
export function alertKindForInboxSender(
    from: string,
    isMachine: boolean,
): AlertKind | null {
    if (!from) return null;
    if (from === 'human') return null;
    return isMachine ? 'automatedNotice' : 'agentMessage';
}

/**
 * Which alert a finished flow run is.
 *
 * `refused` counts as a failure, not a finish: admission turned the graph away,
 * so the automation did not do the thing. A chime that says "finished" for a run
 * that never started is the alert lying about the outcome — and the failure is
 * the case actually worth interrupting someone for.
 */
export function alertKindForFlowOutcome(outcome: string): AlertKind {
    return outcome === 'ran' ? 'flowRun' : 'failure';
}

/**
 * Which alert a supervised process's new status is, or null when it is not an
 * ending at all.
 *
 * `restarting` is the important null: a crash-looping process passes through it
 * up to MAX_RESTART_ATTEMPTS times before it settles, and chiming each time
 * would turn one problem into five interruptions.
 */
export function alertKindForProcessStatus(status: string): AlertKind | null {
    if (status === 'stopped') return 'processExit';
    if (status === 'crashed' || status === 'failed') return 'failure';
    return null;
}
