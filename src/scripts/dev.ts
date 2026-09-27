// Local development in one terminal: API (restarts on file changes), worker and Vite (hot reload on 5173,
// proxies /api to the API). PostgreSQL and S3 must already be running (README, "Avvio locale").
// Ctrl+C stops all three. The worker is NOT restarted on changes: killing it mid-job would leave the job
// locked until graphile-worker's lock timeout, so restart `pnpm dev` after changing worker code.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { styleText } from 'node:util';

const require = createRequire(import.meta.url);
const vitePkg = require.resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePkg), (require(vitePkg) as { bin: { vite: string } }).bin.vite);

const env = ['--env-file-if-exists=.env'];
const services: Array<{ name: string; color: Parameters<typeof styleText>[0]; args: string[] }> = [
  { name: 'api', color: 'cyan', args: ['--watch', ...env, 'src/server/index.ts'] },
  { name: 'worker', color: 'magenta', args: [...env, 'src/worker/index.ts'] },
  { name: 'web', color: 'green', args: [viteBin, '--config', 'web/vite.config.ts'] },
];

if (!existsSync('.env')) console.warn(styleText('yellow', 'Attenzione: .env non trovato. Copiare .env.example in .env (vedi README).'));
console.log(`Avvio di API (http://127.0.0.1:3000), worker e frontend con hot reload (${styleText('bold', 'http://127.0.0.1:5173')}). Ctrl+C per fermare.`);

const children = new Map<string, ChildProcess>();
let stopping = false;

function pipe(name: string, color: Parameters<typeof styleText>[0], stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) {
  const tag = styleText(color, `[${name}]`.padEnd(9));
  createInterface({ input: stream }).on('line', (line) => out.write(`${tag}${line}\n`));
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** On Windows kill() terminates only the direct child: `node --watch` would leave the API process alive. */
function kill(child: ChildProcess, force: boolean) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) if (running(child)) kill(child, false);
  // Children that ignore SIGTERM are killed after a grace period.
  setTimeout(() => {
    for (const child of children.values()) if (running(child)) kill(child, true);
    process.exit(code);
  }, 5000).unref();
  const check = setInterval(() => {
    if (![...children.values()].some(running)) {
      clearInterval(check);
      process.exit(code);
    }
  }, 100);
}

for (const s of services) {
  const child = spawn(process.execPath, s.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0' },
  });
  children.set(s.name, child);
  pipe(s.name, s.color, child.stdout!, process.stdout);
  pipe(s.name, s.color, child.stderr!, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(styleText('red', `[${s.name}] terminato (${signal ?? `codice ${code}`}): fermo anche gli altri processi.`));
    stopAll(code || 1);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
