import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Catalog } from '../core/catalog.js';
import { GAppBook } from './gapps-host.js';

/**
 * `npm run check:package -- <folder>` (GApps v2, V6, Tynn #571): an app package through the host's own checks, the first
 * step of an install and nothing after it, so the reason printed is the reason the host would give. It writes nothing.
 *
 * Genie refuses an unsigned package unless publisher checks are off; `--publisher-checks-off` checks one as that Genie would.
 */
export interface CheckPackagePorts {
    readonly keys: Readonly<Record<string, string>>;
    readonly catalog: () => Catalog;
    readonly write: (line: string) => void;
}

const USAGE = 'Usage: npm run check:package -- <folder> [--publisher-checks-off]';
const CHECKS_OFF = '--publisher-checks-off';

/** The exit code: 0 passes, 1 refused, 2 not asked properly. */
export async function checkPackageCommand(argv: readonly string[], ports: CheckPackagePorts): Promise<number> {
    const folders = argv.filter((a) => !a.startsWith('--'));
    if (folders.length !== 1 || argv.some((a) => a.startsWith('--') && a !== CHECKS_OFF)) {
        ports.write(USAGE);
        return 2;
    }
    const checksOff = argv.includes(CHECKS_OFF);
    // The book is only read for what is installed, and nothing is: this folder is never created.
    const book = await GAppBook.open({ dir: join(tmpdir(), 'genie-check-package-none'), keys: ports.keys, publisherChecksOff: () => checksOff, catalog: ports.catalog });
    const checked = await book.reviewInstall(resolve(folders[0]!));
    if (!checked.ok) {
        ports.write(`Refused: ${checked.reason}`);
        return 1;
    }
    const { review } = checked;
    ports.write(`${review.name} ${review.version} passes Genie's checks.`);
    ports.write(`Digest: ${review.digest}`);
    ports.write(`Publisher: ${review.publisher}`);
    ports.write(review.items.length === 0 ? 'It asks the person for nothing.' : 'The person will be asked to allow:');
    for (const item of review.items) {
        if (item.kind === 'element') ports.write(`  ${item.name}: ${item.description}`);
        else if (item.kind === 'network') ports.write(`  Network: ${item.host}`);
    }
    return 0;
}
