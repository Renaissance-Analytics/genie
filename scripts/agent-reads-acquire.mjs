const IDENTITY_FIELDS = ['build', 'vmId', 'platform', 'runId'];

/** Sequential same-run pairs. The job owns actual processes, measurement and checkpoint storage through these ports. */
export async function acquirePairedRuns({ identity, candidateMode = 'door', pairCount = 3, runSample, checkpoint }) {
    if (!Number.isSafeInteger(pairCount) || pairCount < 3) throw new Error('at least 3 complete pairs are required');
    if (!['door', 'door-revision'].includes(candidateMode)) throw new Error('unknown paired candidate mode');
    // Capture the expected identity before any port runs; a returned sample cannot redefine it.
    const context = { ...identity };
    for (const field of IDENTITY_FIELDS) {
        if (typeof context[field] !== 'string' || context[field].length === 0) throw new Error(`missing run identity: ${field}`);
    }
    const report = { identity: context, candidateMode, pairs: [] };
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const order = pairIndex % 2 === 0 ? ['ipc', 'door'] : ['door', 'ipc'];
        const pair = { order };
        report.pairs.push(pair);
        for (const path of order) {
            const mode = path === 'ipc' ? 'ipc' : candidateMode;
            const sample = await runSample({ identity: { ...context }, pairIndex, mode });
            if (sample?.finished !== true) throw new Error('unfinished acquisition cannot form a complete pair');
            for (const field of IDENTITY_FIELDS) {
                if (sample.identity?.[field] !== context[field]) throw new Error(`sample identity mismatch: ${field}`);
            }
            if (sample.mode !== mode || sample.pairIndex !== pairIndex) throw new Error('sample mode or pair index does not match its request');
            pair[path] = structuredClone(sample);
            // No acquisition starts until this evidence is saved. Each saved report owns its data, including partial pairs.
            await checkpoint(structuredClone(report));
        }
    }
    return report;
}
