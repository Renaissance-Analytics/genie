/** RED seam for paired acquisition. No CLI, Electron or child-process work until its contracts are measured RED. */
export async function acquirePairedRuns({ identity, candidateMode = 'door' }) {
    return { identity, candidateMode, pairs: [] };
}
