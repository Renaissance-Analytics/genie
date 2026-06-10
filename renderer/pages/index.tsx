import { useEffect } from 'react';
import Router from 'next/router';

// Default Next.js index → forward to the tray page so dev URL hits the
// right surface on first load.
export default function Index() {
    useEffect(() => {
        Router.replace('/tray');
    }, []);
    return null;
}
