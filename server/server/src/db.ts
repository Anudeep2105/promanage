import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const localEnvPath of [resolve(process.cwd(), '.env.local'), resolve(process.cwd(), '../../.env.local')]) {
  try {
    const localEnv = readFileSync(localEnvPath, 'utf8');
    for (const key of ['DATABASE_URL', 'CLERK_SECRET_KEY', 'APP_URL', 'WEB_ORIGINS'] as const) {
      if (process.env[key]) continue;
      const match = localEnv.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
      if (match?.[1]) process.env[key] = match[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // Deployments provide credentials through their environment.
  }
}

const prismaClientSingleton = () => {
  return new PrismaClient();
};

declare global {
  var prisma: ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;
