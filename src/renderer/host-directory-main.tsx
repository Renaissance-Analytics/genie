import { initTheme } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostDirectoryAction, HostDirectoryState } from '../main/host-directory-window.js';
import { HostDirectoryScreen } from './components/HostDirectoryScreen.js';
import './styles.css';

/** The host directory (Tynn #1058 L4): HostDirectoryScreen over the preload's `genieHostDirectory`. Pushed, and asked once on load. */
interface HostDirectoryBridge {
    current(): Promise<HostDirectoryState | null>;
    act(action: HostDirectoryAction): Promise<void>;
    onShow(listener: (state: HostDirectoryState) => void): () => void;
}
const bridge = (window as unknown as { genieHostDirectory?: HostDirectoryBridge }).genieHostDirectory;

function HostDirectoryApp() {
    const [state, setState] = useState<HostDirectoryState | null>(null);
    useEffect(() => {
        if (!bridge) return;
        const off = bridge.onShow(setState);
        void bridge.current().then((s) => { if (s) setState((now) => now ?? s); });
        return off;
    }, []);
    if (!state) return null;
    return <HostDirectoryScreen view={state.view} busy={state.busy} notice={state.notice} onAction={(action) => { void bridge?.act(action); }} />;
}

initTheme();
const root = document.getElementById('root');
if (root) createRoot(root).render(<HostDirectoryApp />);
