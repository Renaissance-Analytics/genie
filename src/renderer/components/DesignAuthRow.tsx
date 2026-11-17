import { Badge, Button } from '@particle-academy/react-fancy';
import type { DesignAuthView } from '../../core/design-auth.js';

/**
 * CLAUDE DESIGN'S AUTHORIZATION, ONE FOR THE MACHINE (Tynn #480, decision 5), where the Claude accounts are: its state (Authorized
 * only after the call that needed it succeeded) and one-click Design sign-in, which opens Claude Code in its one home for the
 * person to type /design-login. It says it is for this machine, not for an account.
 */
export function DesignAuthRow({ design, onSignIn }: { design: DesignAuthView; onSignIn?: (() => void) | undefined }) {
    return (
        <div data-design-auth={design.state} className="flex flex-wrap items-center gap-2 border-t border-[var(--border-1)] pt-2 text-xs">
            <span className="font-medium">Claude Design</span>
            <Badge size="sm" variant="soft" color={design.authorized ? 'green' : design.state === 'unknown' ? 'zinc' : 'amber'} data-design-auth-words="">{design.words}</Badge>
            <span className="text-[var(--fg-4)]">One sign-in for this machine</span>
            <Button type="button" size="xs" className="ml-auto" data-action="design-sign-in" onClick={() => onSignIn?.()}>Design sign-in</Button>
        </div>
    );
}
