export const ELECTRON_BUILDER_VERSION: string;
export const OUR_PUBLISHER: string;
export function shouldSignFile(file: string, signExts: readonly string[] | null | undefined, fallbackValue?: boolean): boolean;
export function signPlan(root: string, config: { productFilename: string; signExts: readonly string[] | null }): string[];
export function classify(status: string, subject: string): { kind: 'ours' | 'third-party' | 'unsigned' | 'invalid'; signer: string | null; status?: string };
