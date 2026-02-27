/**
 * CarapaceOS Runner — Public API
 * 
 * Programmatic interface for booting isolated CarapaceOS VMs
 * and running AI agent tasks inside them.
 * 
 * @example
 * import { CarapaceRunner, runIsolated } from 'carapaceos-runner';
 * 
 * // One-liner: boot, run, destroy
 * const result = await runIsolated('node --version', { image: './carapaceos.qcow2' });
 * console.log(result.stdout); // v22.x.x
 * 
 * // Full lifecycle control
 * const runner = new CarapaceRunner({ image: './carapaceos.qcow2' });
 * await runner.boot();
 * await runner.run('npm install');
 * const test = await runner.run('npm test');
 * await runner.shutdown();
 */

export { CarapaceRunner, runIsolated } from './lib/agent-runner.js';
export { WarmPool, getGlobalPool, stopGlobalPool } from './lib/warm-pool.js';
export { createSeedISO, buildISO } from './lib/seed-iso.js';
export { ControlServer } from './lib/control-server.js';
// Image fetcher: use CLI `carapace-fetch` or script `npm run fetch-image`
