// Starts simulated processors for development: a redundant pair of Brompton Tessera SX40s, a NovaStar
// COEX MX40 Pro and a NovaStar VX Pro on its TCP control protocol. Nothing here talks to real equipment.
//
//   npm run sim
//
// Then add them in Setup (Brompton 127.0.0.1:8081 and :8082, COEX 127.0.0.1:8011, VX Pro
// 127.0.0.1:15200), or let Scan find the Tessera and COEX ones:
//   RCS_LED_SCAN=127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8011 npm run dev
// Switch faults on with  curl 'http://127.0.0.1:8081/sim/scenario?set=fan-failure'  (see src/sim/*.ts).
import { CoexSimulator } from './sim/coex.js';
import { TesseraSimulator } from './sim/tessera.js';
import { VxSimulator } from './sim/vxpro.js';

const host = process.env.RCS_LED_SIM_HOST ?? '127.0.0.1';
const main = new TesseraSimulator({ name: 'Stage Main', serial: '900001', role: 'primary', partnerName: 'Stage Backup', partnerSerial: '900002' });
const backup = new TesseraSimulator({ name: 'Stage Backup', serial: '900002', role: 'backup', partnerName: 'Stage Main', partnerSerial: '900001' });
const coex = new CoexSimulator({ name: 'Side IMAG', serial: '700001' });
const vx = new VxSimulator();

const ports = [await main.listen(8081, host), await backup.listen(8082, host), await coex.listen(8011, host), await vx.listen(15200, host)];
console.log(`Tessera SX40 "Stage Main"    http://${host}:${ports[0]}/api/`);
console.log(`Tessera SX40 "Stage Backup"  http://${host}:${ports[1]}/api/`);
console.log(`COEX MX40 Pro "Side IMAG"    http://${host}:${ports[2]}/api/v1/device/hw`);
console.log(`VX Pro                       tcp ${host}:${ports[3]}`);
console.log(`Scenarios: curl 'http://${host}:${ports[0]}/sim/scenario?set=fan-failure'`);

const stop = async () => {
  await Promise.all([main.close(), backup.close(), coex.close(), vx.close()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
