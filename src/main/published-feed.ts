import type { AllPublishOptions } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';

/** Tests-first configuration seam. Preserve every existing feed until its replacement is proved. */
export function configurePublishedFeed(_updater: Pick<AppUpdater, 'setFeedURL'>, _config: AllPublishOptions | null): boolean {
    return false;
}
