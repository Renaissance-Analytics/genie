import { installMeasurementHostHeartbeat, installMeasurementHostPhases } from './artboard-gap-probe.mjs';

// Imported only by the measurement launch hook; a direct import without its flags remains inert.
const gauge = installMeasurementHostHeartbeat();
if (gauge.enabled) process.once('exit', () => gauge.stop());
// The ArtBoard build runs here (Tynn #898 step 2d-4b): its phases are written to this host's log, for measure() to read.
installMeasurementHostPhases();
