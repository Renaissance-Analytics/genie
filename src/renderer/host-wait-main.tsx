import { initTheme } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostWaitAction, HostWaitView } from '../main/host-wait-window.js';
import { HostWaitScreen } from './components/HostWaitScreen.js';
import './styles.css';

/** The wait for Genie's host (Tynn #700): HostWaitScreen over the host-wait preload's `genieHostWait`. Pushed, and asked once on load. */
interface HostWaitBridge {
    current(): Promise<HostWaitView | null>;
    act(action: HostWaitAction): Promise<void>;
    onShow(listener: (view: HostWaitView) => void): () => void;
}
const bridge = (window as unknown as { genieHostWait?: HostWaitBridge }).genieHostWait;

function HostWaitApp() {
    const [view, setView] = useState<HostWaitView | null>(null);
    useEffect(() => {
        if (!bridge) return;
        const off = bridge.onShow(setView);
        void bridge.current().then((v) => { if (v) setView((now) => now ?? v); });
        return off;
    }, []);
    if (!view) return null;
    return <HostWaitScreen view={view} onAction={(action) => { void bridge?.act(action); }} />;
}

initTheme();
const host = document.getElementById('root');
if (host) createRoot(host).render(<HostWaitApp />);
