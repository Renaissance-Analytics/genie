import { initTheme } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OsaFacts } from '../core/osa-home.js';
import { DoctorApp, type DoctorBridge, type DoctorDetail } from './DoctorApp.js';
import { registerAppIcons } from './icons.js';
import './styles.css';

/**
 * The doctor window's renderer (`genie --doctor`): DoctorApp over the doctor preload's `genieDoctor`. Pushed, never
 * polled: the main process signals a change and the window reads the detail again.
 */
declare global {
    interface Window { genieDoctor?: DoctorBridge }
}

function Doctor({ bridge }: { bridge: DoctorBridge }) {
    const [facts, setFacts] = useState<OsaFacts | null>(null);
    const [connect, setConnect] = useState<string | null>(null);
    const [detail, setDetail] = useState<DoctorDetail | null>(null);
    const [answering, setAnswering] = useState<string | null>(null);
    useEffect(() => {
        void bridge.facts().then(setFacts);
        const read = () => { void bridge.detail().then(setDetail); void bridge.connect().then(setConnect); };
        read();
        return bridge.onChange(read);
    }, [bridge]);
    return (
        <DoctorApp
            facts={facts}
            connect={connect}
            detail={detail}
            onSend={(text, attachments) => { void bridge.prompt(text, attachments ?? []); }}
            onStart={() => { void bridge.start(); }}
            answeringApproval={answering}
            onAnswerApproval={(optionId) => { setAnswering(optionId); void bridge.answerApproval(optionId).finally(() => setAnswering(null)); }}
        />
    );
}

registerAppIcons();
initTheme();
const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from doctor.html');
const bridge = window.genieDoctor;
createRoot(host).render(bridge ? <Doctor bridge={bridge} /> : <p style={{ padding: 16 }}>The doctor window’s bridge is missing.</p>);
