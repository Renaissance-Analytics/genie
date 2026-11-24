import { Badge, Icon } from '@particle-academy/react-fancy';
import { releaseMarkOf, type ReleaseLook } from '../../core/release-kind.js';

/**
 * A VERSION'S KIND, PAINTED WITH TYNN'S COLOUR TOKEN (Tynn #933; workspace-ux 0.13.0 `release_kind`, `colour`), as
 * tynn.ai's own kind badge is. A hotfix says so in words; a normal release is its icon in its colour (few words). Nothing
 * is drawn for a version Tynn named no kind for.
 */
export function ReleaseKindMark({ release }: { release: ReleaseLook | null }) {
    if (release === null) return null;
    const mark = releaseMarkOf(release);
    return (
        <Badge size="sm" color={mark.colour} variant={mark.solid ? 'solid' : 'soft'} data-release-kind={mark.kind} data-release-colour={mark.colour} title={mark.label} aria-label={mark.label}>
            <Icon name={mark.icon} size="xs" />{mark.solid ? ` ${mark.label}` : null}
        </Badge>
    );
}
