import { installMeasurementHostHeartbeat } from './artboard-gap-probe.mjs';

// Imported only by the measurement launch hook; a direct import without its flags remains inert.
const gauge = installMeasurementHostHeartbeat();
if (gauge.enabled) process.once('exit', () => gauge.stop());
