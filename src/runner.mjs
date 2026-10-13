// Spawns a career-ops core script as a child process with CAREER_OPS_ROOT
// pointed at the user's (temp, S3-synced) data dir. LLM keys are forwarded
// via env and never logged.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.mjs';

export function runCareerOpsScript({ script, args = [], dataRoot, timeoutMs = config.jobTimeoutMs }) {
  return new Promise((resolve) => {
    const scriptPath = path.join(config.careerOpsHome, script);
    const env = { ...process.env, CAREER_OPS_ROOT: dataRoot };
    for (const k of config.forwardEnv) {
      if (process.env[k]) env[k] = process.env[k];
    }
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: config.careerOpsHome,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s) => (s.length > config.maxLogBytes ? s.slice(-config.maxLogBytes) : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout + d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr + d.toString()); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    // Don't let the timer keep the worker alive on its own.
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + '\nspawn error: ' + err.message, timedOut });
    });
  });
}
