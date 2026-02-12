#!/usr/bin/env node
/**
 * CarapaceOS Agent Audit
 * Checks if an environment is safe and ready for AI agent operations.
 * 
 * Usage: node agent-audit.js [--json] [--fix]
 * 
 * Checks:
 * - Required tools (node, git, bash, curl)
 * - User permissions (non-root)
 * - Workspace writability
 * - Network access
 * - Resource limits (memory, disk)
 * - Security posture (no secrets exposed, restricted paths)
 */

const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');

const CHECKS = [];
const RESULTS = { pass: 0, warn: 0, fail: 0, skip: 0 };

function check(name, fn) {
    CHECKS.push({ name, fn });
}

function result(name, status, detail) {
    const icons = { pass: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };
    RESULTS[status]++;
    return { name, status, detail, icon: icons[status] };
}

function tryExec(cmd, timeout = 5000) {
    try {
        return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
        return null;
    }
}

// === TOOL CHECKS ===

check('Node.js available', () => {
    const ver = tryExec('node --version');
    if (!ver) return result('Node.js', 'fail', 'node not found');
    const major = parseInt(ver.replace('v', ''));
    if (major < 18) return result('Node.js', 'warn', `${ver} (recommend >= 18)`);
    return result('Node.js', 'pass', ver);
});

check('Git available', () => {
    const ver = tryExec('git --version');
    if (!ver) return result('Git', 'fail', 'git not found');
    return result('Git', 'pass', ver);
});

check('Bash available', () => {
    const ver = tryExec('bash --version 2>/dev/null | head -1');
    if (!ver) return result('Bash', 'fail', 'bash not found');
    return result('Bash', 'pass', ver.split('\n')[0]);
});

check('curl available', () => {
    const ver = tryExec('curl --version 2>/dev/null | head -1');
    if (!ver) return result('curl', 'warn', 'curl not found (HTTP requests limited)');
    return result('curl', 'pass', ver.split('\n')[0]);
});

check('npm available', () => {
    const ver = tryExec('npm --version');
    if (!ver) return result('npm', 'warn', 'npm not found (cannot install packages)');
    return result('npm', 'pass', `v${ver}`);
});

// === SECURITY CHECKS ===

check('Non-root user', () => {
    const uid = process.getuid?.();
    if (uid === undefined) return result('Non-root', 'skip', 'getuid not available');
    if (uid === 0) return result('Non-root', 'fail', 'Running as root! Agents should run as unprivileged user');
    const user = tryExec('whoami') || `uid:${uid}`;
    return result('Non-root', 'pass', `Running as ${user} (uid:${uid})`);
});

check('No sensitive env vars leaked', () => {
    const sensitive = ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY', 'DATABASE_URL', 'PRIVATE_KEY', 'SECRET_KEY'];
    const found = sensitive.filter(k => process.env[k]);
    if (found.length > 0) {
        return result('Env secrets', 'warn', `Found ${found.length} sensitive env vars: ${found.join(', ')}`);
    }
    return result('Env secrets', 'pass', 'No sensitive env vars detected');
});

check('Restricted paths not writable', () => {
    const restricted = ['/etc/passwd', '/etc/shadow', '/usr/bin', '/sbin'];
    const writable = restricted.filter(p => {
        try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
    });
    if (writable.length > 0) {
        return result('Restricted paths', 'warn', `Writable: ${writable.join(', ')}`);
    }
    return result('Restricted paths', 'pass', 'System paths are read-only');
});

check('No sudo/su available', () => {
    const hasSudo = tryExec('which sudo 2>/dev/null');
    const hasSu = tryExec('which su 2>/dev/null');
    if (hasSudo || hasSu) {
        return result('Privilege escalation', 'warn', 'sudo/su available (consider removing)');
    }
    return result('Privilege escalation', 'pass', 'No privilege escalation tools');
});

// === WORKSPACE CHECKS ===

check('Workspace writable', () => {
    const workspace = process.env.AGENT_WORKSPACE || process.cwd();
    try {
        const testFile = path.join(workspace, '.agent-audit-test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        return result('Workspace', 'pass', `${workspace} is writable`);
    } catch {
        return result('Workspace', 'fail', `${workspace} is not writable`);
    }
});

check('Git configured', () => {
    const name = tryExec('git config user.name');
    const email = tryExec('git config user.email');
    if (!name || !email) {
        return result('Git config', 'warn', 'Git user.name/email not set (commits will fail)');
    }
    return result('Git config', 'pass', `${name} <${email}>`);
});

// === RESOURCE CHECKS ===

check('Available memory', () => {
    const totalMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    if (freeMB < 128) return result('Memory', 'fail', `${freeMB}MB free / ${totalMB}MB total (need >= 128MB)`);
    if (freeMB < 512) return result('Memory', 'warn', `${freeMB}MB free / ${totalMB}MB total`);
    return result('Memory', 'pass', `${freeMB}MB free / ${totalMB}MB total`);
});

check('Available disk space', () => {
    const df = tryExec("df -m . 2>/dev/null | tail -1 | awk '{print $4}'");
    if (!df) return result('Disk', 'skip', 'Could not check disk space');
    const freeMB = parseInt(df);
    if (freeMB < 100) return result('Disk', 'fail', `${freeMB}MB free (need >= 100MB)`);
    if (freeMB < 1024) return result('Disk', 'warn', `${freeMB}MB free`);
    return result('Disk', 'pass', `${freeMB}MB free`);
});

check('CPU count', () => {
    const cpus = os.cpus().length;
    if (cpus < 1) return result('CPUs', 'warn', 'No CPU info available');
    return result('CPUs', 'pass', `${cpus} cores`);
});

// === NETWORK CHECKS ===

check('DNS resolution', () => {
    const resolved = tryExec('getent hosts github.com 2>/dev/null || nslookup github.com 2>/dev/null | head -3');
    if (!resolved) return result('DNS', 'warn', 'DNS resolution failed (may be offline)');
    return result('DNS', 'pass', 'github.com resolves');
});

check('HTTPS connectivity', () => {
    const response = tryExec('curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://api.github.com 2>/dev/null');
    if (!response || response === '000') return result('HTTPS', 'warn', 'Cannot reach api.github.com');
    return result('HTTPS', 'pass', `api.github.com returned ${response}`);
});

// === CONTAINER DETECTION ===

check('Container runtime', () => {
    const inDocker = fs.existsSync('/.dockerenv');
    const inContainer = tryExec('cat /proc/1/cgroup 2>/dev/null | grep -q docker && echo yes') === 'yes';
    const inK8s = !!process.env.KUBERNETES_SERVICE_HOST;
    
    if (inK8s) return result('Runtime', 'pass', 'Kubernetes pod');
    if (inDocker || inContainer) return result('Runtime', 'pass', 'Docker container');
    return result('Runtime', 'pass', 'Bare metal / VM');
});

// === RUN ===

async function main() {
    const jsonOutput = process.argv.includes('--json');
    const results = [];

    if (!jsonOutput) {
        console.log('🦞 CarapaceOS Agent Audit');
        console.log('========================\n');
    }

    for (const { name, fn } of CHECKS) {
        try {
            const r = fn();
            results.push(r);
            if (!jsonOutput) {
                console.log(`${r.icon} ${r.name}: ${r.detail}`);
            }
        } catch (err) {
            const r = result(name, 'fail', `Check error: ${err.message}`);
            results.push(r);
            if (!jsonOutput) {
                console.log(`${r.icon} ${name}: ${r.detail}`);
            }
        }
    }

    const score = Math.round((RESULTS.pass / (RESULTS.pass + RESULTS.warn + RESULTS.fail)) * 100);

    if (jsonOutput) {
        console.log(JSON.stringify({ results, summary: RESULTS, score }, null, 2));
    } else {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`Score: ${score}% agent-ready`);
        console.log(`✅ ${RESULTS.pass} passed  ⚠️ ${RESULTS.warn} warnings  ❌ ${RESULTS.fail} failed  ⏭️ ${RESULTS.skip} skipped`);
        
        if (RESULTS.fail > 0) {
            console.log('\n💡 Fix failures before running agents in this environment.');
            process.exitCode = 1;
        } else if (RESULTS.warn > 0) {
            console.log('\n💡 Warnings are advisory — environment is usable but could be hardened.');
        } else {
            console.log('\n🦞 Environment is fully agent-ready!');
        }
    }
}

main();
