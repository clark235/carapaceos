#!/usr/bin/env node
/**
 * CarapaceOS Agent Runner - Integration Test
 * 
 * Boots the real VM and validates the runner API works end-to-end.
 * Run: node test-runner.js
 */

import { CarapaceRunner } from './agent-runner.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE = join(__dirname, '../vm-image/carapaceos.qcow2');

async function main() {
  console.log('🦞 CarapaceOS Agent Runner Test');
  console.log('================================');
  console.log(`Image: ${IMAGE}`);
  console.log('');

  const runner = new CarapaceRunner({
    image: IMAGE,
    memory: '512',
    verbose: true,
    enableKVM: true,
  });

  console.log(`📋 Runner info: SSH port ${runner.info.sshPort}`);
  console.log('');

  try {
    // Boot the VM
    console.log('🚀 Booting VM...');
    const bootStart = Date.now();
    await runner.boot();
    const bootTime = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`✅ VM booted in ${bootTime}s`);
    console.log('');

    // Run validation steps
    const steps = [
      { name: 'OS version',    command: 'cat /etc/carapaceos-version' },
      { name: 'Hostname',       command: 'hostname' },
      { name: 'User',           command: 'whoami' },
      { name: 'Node.js',        command: 'node --version' },
      { name: 'npm',            command: 'npm --version' },
      { name: 'git',            command: 'git --version' },
      { name: 'Memory',         command: "free -h | awk 'NR==2{print $2}'", optional: true },
      { name: 'Disk space',     command: "df -h / | awk 'NR==2{print $4}' | tr -d '\\n'", optional: true },
      { name: 'CPU count',      command: 'nproc', optional: true },
      { name: 'Workspace',      command: 'ls /home/agent/workspace' },
      { name: 'Env vars',       command: 'env | grep -E "^(CARAPACEOS|AGENT|HOME)" | sort' },
    ];

    console.log('🔍 Running validation checks...');
    let passed = 0;
    let failed = 0;

    for (const step of steps) {
      try {
        const r = await runner.run(step.command, { timeout: 15 });
        if (r.code === 0) {
          const output = r.stdout || '(empty)';
          console.log(`  ✅ ${step.name}: ${output.split('\n')[0]}`);
          passed++;
        } else {
          if (step.optional) {
            console.log(`  ⚠️  ${step.name}: exit ${r.code} (optional, skipping)`);
          } else {
            console.log(`  ❌ ${step.name}: exit ${r.code} — ${r.stderr}`);
            failed++;
          }
        }
      } catch (err) {
        if (step.optional) {
          console.log(`  ⚠️  ${step.name}: ${err.message} (optional)`);
        } else {
          console.log(`  ❌ ${step.name}: ${err.message}`);
          failed++;
        }
      }
    }

    console.log('');
    console.log(`📊 Results: ${passed} passed, ${failed} failed`);
    console.log('');

    // Test multi-step task API
    console.log('🧪 Testing runTask() API...');
    const taskResults = await runner.runTask([
      { name: 'Create file',   command: 'echo "hello from carapaceos" > /tmp/test.txt' },
      { name: 'Read file',     command: 'cat /tmp/test.txt' },
      { name: 'Delete file',   command: 'rm /tmp/test.txt' },
      { name: 'Verify deleted', command: '[ ! -f /tmp/test.txt ] && echo "gone"' },
    ]);

    taskResults.forEach(r => {
      const icon = r.success ? '✅' : '❌';
      const out = r.stdout || r.error || '';
      console.log(`  ${icon} ${r.name}: ${out} (${r.duration}ms)`);
    });

    console.log('');

    // Test Node.js execution inside the VM
    console.log('🧪 Testing Node.js execution inside VM...');
    const nodeResult = await runner.run(`node -e "
const os = require('os');
const info = {
  platform: os.platform(),
  arch: os.arch(),
  cpus: os.cpus().length,
  memory: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
  hostname: os.hostname(),
};
console.log(JSON.stringify(info, null, 2));
"`, { timeout: 10 });

    if (nodeResult.code === 0) {
      console.log('  ✅ Node.js in VM:');
      nodeResult.stdout.split('\n').forEach(l => console.log(`     ${l}`));
    } else {
      console.log(`  ❌ Node.js failed: ${nodeResult.stderr}`);
    }

    console.log('');
    console.log('🎉 All tests complete!');
    
    return failed === 0 ? 0 : 1;

  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    return 1;
  } finally {
    console.log('');
    console.log('⏹️  Shutting down VM...');
    await runner.shutdown();
    console.log('✅ Shutdown complete');
  }
}

main().then(process.exit).catch(err => {
  console.error(err);
  process.exit(1);
});
