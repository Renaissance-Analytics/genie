import type { AcquisitionReport } from './agent-reads-acquire.mjs';
export interface M4DiagnosticResult {
    readonly kind: 'm4-diagnostic';
    readonly finished: boolean;
    readonly acceptance: false;
    readonly report?: AcquisitionReport;
}
export function runM4Diagnostic(options: { readonly outDir: string }): Promise<M4DiagnosticResult>;
