/** RED page-expression seams; no measurement call site uses these until their assertion RED is measured. */
export function ledgerProbe(_agentId, _rows, _extraWorkMs = 0) { return 'Promise.resolve({ ms: 0, maxGapMs: 0 })'; }
export function snapshotProbe(_extraWorkMs = 0) { return 'Promise.resolve(0)'; }
export function busyWorkProbe(_extraWorkMs) { return '0'; }
