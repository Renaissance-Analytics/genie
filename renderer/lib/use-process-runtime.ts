import { useEffect, useState } from 'react';
import { api, type ProcessStatus, type ScheduleInfo } from './genie';

/**
 * The live runtime facts about background processes: each one's status, and each
 * scheduled task's next run as the Host describes it.
 *
 * Shared by the sidebar's process box (which colours itself from the statuses) and
 * the Processes modal, so both read the same source rather than two subscriptions
 * that could disagree. The headless supervisor in main is the source of truth; both
 * facts arrive by PUSH (`processStatus`, `scheduleNext`), with one read on mount.
 */
export function useProcessRuntime(): {
    processStatus: Map<string, ProcessStatus>;
    scheduleInfo: Map<string, ScheduleInfo>;
} {
    const [processStatus, setProcessStatus] = useState<Map<string, ProcessStatus>>(() => new Map());
    const [scheduleInfo, setScheduleInfo] = useState<Map<string, ScheduleInfo>>(() => new Map());

    useEffect(() => {
        let alive = true;
        void api()
            .process.statuses()
            .then((m) => {
                if (alive) setProcessStatus(new Map(Object.entries(m) as [string, ProcessStatus][]));
            })
            .catch(() => {});
        const off = api().on.processStatus(({ id, status }) =>
            setProcessStatus((prev) => {
                const next = new Map(prev);
                next.set(id, status);
                return next;
            }),
        );
        return () => {
            alive = false;
            off();
        };
    }, []);

    useEffect(() => {
        let alive = true;
        const load = () =>
            void api()
                .schedule.info()
                .then((m) => {
                    if (alive) setScheduleInfo(new Map(Object.entries(m)));
                })
                .catch(() => {});
        load();
        // The Host re-describes a task whenever it is armed, fires, or is disarmed.
        const offNext = api().on.scheduleNext(({ id, nextAt, description }) =>
            setScheduleInfo((prev) => {
                const next = new Map(prev);
                if (description === null) next.delete(id); // no longer a scheduled task
                else next.set(id, { nextAt, description });
                return next;
            }),
        );
        // A spec set change can ADD a scheduled task created elsewhere (the MCP
        // tool, another window) — re-read so it shows a schedule immediately.
        const offSpecs = api().on.terminalSpecsChanged(load);
        return () => {
            alive = false;
            offNext();
            offSpecs();
        };
    }, []);

    return { processStatus, scheduleInfo };
}
