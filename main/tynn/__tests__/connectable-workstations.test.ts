import { describe, expect, it } from 'vitest';
import type { ConnectableWorkstation } from '../../backend/tynn';
import { visibleConnectableWorkstations } from '../connectable-workstations';

const workstation = (id: string): ConnectableWorkstation => ({
    id,
    name: id,
    status: 'active',
    is_local: false,
    relay_endpoint: 'wss://relay.test',
    connectable: true,
    capability: 'control',
    scopes: ['host:all'],
    source: 'owner',
});

describe('visibleConnectableWorkstations', () => {
    it('deduplicates by id and excludes this local Genie', () => {
        expect(visibleConnectableWorkstations([
            workstation('self'),
            workstation('remote'),
            { ...workstation('remote'), name: 'Remote updated' },
        ], 'self')).toEqual([{ ...workstation('remote'), name: 'Remote updated' }]);
    });
});
