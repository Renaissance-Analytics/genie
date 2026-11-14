/** Same five ordinary opens and spacing, then the control and a separate stage open. No diagnostic enters the median. */
export async function measureM4Block({ openOrdinary, sleep, openControl, openStages }) {
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
        const run = await openOrdinary();
        if (!finite(run?.ms) || !finite(run?.maxGapMs)) throw new Error('invalid ordinary M4 observation');
        runs.push(run);
        await sleep(500);
    }
    const sorted = runs.map((run) => run.ms).sort((a, b) => a - b);
    const ordinary = { ms: sorted[2], maxGapMs: Math.max(...runs.map((run) => run.maxGapMs)), runs };
    const control = await openControl(ordinary);
    if (!finite(control?.ms) || !finite(control?.maxGapMs)) throw new Error('invalid M4 control observation');
    const stages = await openStages();
    if (!['producerMs', 'decodeMs', 'rebuildMs', 'totalMs'].every((key) => finite(stages?.[key]))) {
        throw new Error('missing or invalid diagnostic stage observation');
    }
    return { ordinary, control, stages };
}
