import { Fragment, useState } from 'react';
import { Button, Dropdown, Icon, Modal } from '@particle-academy/react-fancy';
import type { RowAction, RowConfirm } from './hosting-rows.js';

/**
 * A ROW'S "⋯" MENU AND ITS ICON BUTTONS (Tynn #708). The row's primary actions are icon buttons named by their label (an
 * accessible name and a tooltip); every other action waits in this menu, the destructive ones last and red. A destructive
 * entry asks first, in a dialog that says what it does; pressing the entry sends nothing. All controls are react-fancy's Button.
 */

/** One primary action: an icon-only circle button. `loading` spins it; `disabled` greys it. */
export function RowIconButton({ action, onRun, disabled = false, loading = false, ...rest }: { action: RowAction; onRun: (a: RowAction) => void; disabled?: boolean; loading?: boolean } & Record<`data-${string}`, string>) {
    return (
        <Button
            type="button"
            variant="circle"
            size="sm"
            icon={action.icon}
            {...(action.danger ? { color: 'red' as const } : {})}
            aria-label={action.label}
            title={action.label}
            disabled={disabled || action.disabled === true}
            loading={loading}
            onClick={() => onRun(action)}
            {...rest}
        />
    );
}

export function RowMenu({ items, onRun, label = 'More actions', disabled = false, loading = false }: { items: readonly RowAction[]; onRun: (a: RowAction) => void; label?: string; disabled?: boolean; loading?: boolean }) {
    const [asking, setAsking] = useState<(RowAction & { confirm: RowConfirm }) | null>(null);
    if (items.length === 0) return null;
    return (
        <>
            <Dropdown placement="bottom-end">
                <Dropdown.Trigger>
                    <Button type="button" variant="circle" size="sm" icon="ellipsis" aria-label={label} title={label} disabled={disabled} loading={loading} data-row-menu="" />
                </Dropdown.Trigger>
                <Dropdown.Items>
                    {items.map((item, n) => (
                        <Fragment key={item.id}>
                            {item.danger && n > 0 && !items[n - 1]!.danger ? <Dropdown.Separator /> : null}
                            <Dropdown.Item
                                {...(item.danger ? { danger: true } : {})}
                                disabled={item.disabled === true}
                                onClick={() => (typeof item.confirm === 'object' ? setAsking({ ...item, confirm: item.confirm }) : onRun(item))}
                            >
                                <span className="flex items-center gap-2 whitespace-nowrap"><Icon name={item.icon} size="sm" />{item.label}</span>
                            </Dropdown.Item>
                        </Fragment>
                    ))}
                </Dropdown.Items>
            </Dropdown>
            <Modal open={asking !== null} onClose={() => setAsking(null)} size="sm">
                <Modal.Header>{asking?.confirm.title ?? ''}</Modal.Header>
                <Modal.Body><p data-row-confirm="" className="text-sm">{asking?.confirm.body ?? ''}</p></Modal.Body>
                <Modal.Footer>
                    <Button type="button" onClick={() => setAsking(null)}>Cancel</Button>
                    <Button type="button" color="red" data-row-confirm-yes="" onClick={() => { const a = asking; setAsking(null); if (a) onRun(a); }}>{asking?.confirm.confirmLabel ?? 'Confirm'}</Button>
                </Modal.Footer>
            </Modal>
        </>
    );
}
