import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const localEnv = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const databaseUrl = localEnv.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');

if (!databaseUrl) {
  console.error('DATABASE_URL is missing from .env.local.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/with-local-database.mjs <command> [arguments]');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const [action, ...actionArgs] = args;
const command = action === 'dev'
  ? (isWindows ? 'npm.cmd' : 'npm')
  : (isWindows ? 'npx.cmd' : 'npx');
const commandArgs = action === 'dev' ? ['run', 'dev'] : action === 'prisma' ? ['prisma', ...actionArgs] : null;

if (!commandArgs) {
  console.error('Supported local commands: dev, prisma <Prisma arguments>');
  process.exit(1);
}

const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
  shell: isWindows,
});

child.on('error', (error) => {
  console.error(`Could not start ${action}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
