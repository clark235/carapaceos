#!/usr/bin/env node
/**
 * carapace-run CLI
 * 
 * Boot a CarapaceOS VM, run a command, print output, shutdown.
 * 
 * Usage:
 *   carapace-run "node --version"
 *   carapace-run --memory 1024 "npm test"
 *   carapace-run --image /path/to/custom.qcow2 "echo hello"
 *   carapace-run --keep "bash"   # keep VM running after (useful for debugging)
 */

import { CarapaceRunner } from './agent-runner.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    image: join(__dirname, '../vm-image/carapaceos.qcow2'),
    memory: '512',
    verbose: false,
    keep: false,
    timeout: 120,
  };
  const commands = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--image':  opts.image = args[++i]; break;
      case '--memory': opts.memory = args[++i]; break;
      case '--timeout': opts.timeout = parseInt(args[++i]); break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--keep': opts.keep = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default: commands.push(args[i]);
    }
  }

  return { opts, command: commands.join(' ') };
}

function printHelp() {
  console.log(`
carapace-run - Run commands in an isolated CarapaceOS VM

Usage:
  carapace-run [options] <command>

Options:
  --image <path>    Path to CarapaceOS qcow2 image
  --memory <MB>     VM memory in MB (default: 512)
  --timeout <sec>   Command timeout in seconds (default: 120)
  --verbose, -v     Verbose output
  --keep            Don't shutdown VM after run (for debugging)
  --help, -h        Show this help

Examples:
  carapace-run "node --version"
  carapace-run --memory 1024 "npm install && npm test"
  carapace-run --verbose "cat /etc/carapaceos-version"
`);
}

async function main() {
  const { opts, command } = parseArgs(process.argv);

  if (!command) {
    console.error('Error: No command specified. Use --help for usage.');
    process.exit(1);
  }

  const runner = new CarapaceRunner({
    image: opts.image,
    memory: opts.memory,
    verbose: opts.verbose,
    taskTimeout: opts.timeout,
  });

  if (opts.verbose) {
    console.error(`[carapace-run] Image: ${opts.image}`);
    console.error(`[carapace-run] Memory: ${opts.memory}MB`);
    console.error(`[carapace-run] Command: ${command}`);
    console.error(`[carapace-run] SSH port: ${runner.info.sshPort}`);
  }

  try {
    if (opts.verbose) console.error('[carapace-run] Booting VM...');
    await runner.boot();
    if (opts.verbose) console.error('[carapace-run] VM ready');

    const result = await runner.run(command, { timeout: opts.timeout });

    if (result.stdout) process.stdout.write(result.stdout + '\n');
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    
    if (!opts.keep) {
      await runner.shutdown();
    } else {
      console.error(`[carapace-run] VM kept running on SSH port ${runner.info.sshPort}`);
      console.error(`[carapace-run] Connect: ssh -p ${runner.info.sshPort} agent@127.0.0.1`);
    }

    process.exit(result.code);

  } catch (err) {
    console.error(`[carapace-run] Error: ${err.message}`);
    await runner.shutdown().catch(() => {});
    process.exit(1);
  }
}

main();
