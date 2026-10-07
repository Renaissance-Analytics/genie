import { useEffect } from 'react';

// Default Next.js index → forward to the tray page so dev URL hits the
// right surface on first load.
export default function Index() {
    useEffect(() => {
        // Relative, and `.html`: the packaged app loads pages over file://, where an
        // absolute path resolves to the filesystem root.
        window.location.replace('./tray.html');
    }, []);
    return null;
}
