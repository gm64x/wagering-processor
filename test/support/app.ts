import './env';
import 'reflect-metadata';
import { closeSync, openSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { baseEnv, LOG_DIR, REPO_ROOT } from './env';
import { sleep, waitFor } from './wait';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface InProcessApp {
  baseUrl: string;
  app: INestApplication;
  close(): Promise<void>;
}

/**
 * Uma aplicação Nest real (Postgres + SQS reais) dentro do processo de teste, em uma porta aleatória.
 * `env` é aplicado ao process.env enquanto o app é montado e iniciado (o app lê no construtor / bootstrap)
 * e restaurado depois. Os workers (consumer, publisher do outbox, loop de pending-reference) ficam DESLIGADOS
 * a menos que WORKERS_ENABLED=true seja passado: os testes então acionam manualmente (pollOnce / publishBatch / runOnce).
 */
export async function startInProcessApp(env: Record<string, string> = {}): Promise<InProcessApp> {
  const merged = baseEnv({ WORKERS_ENABLED: 'false', LOG_LEVEL: 'silent', ...env });
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      app,
      close: () => app.close(),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface Instance {
  name: string;
  url: string;
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  logFile: string;
  kill(signal?: NodeJS.Signals | number): Promise<{ exitCode: number | null; signalCode: number | string | null }>;
  exited: Promise<number>;
  readLog(): Promise<string>;
}

const spawned = new Set<Instance>();

/**
 * Sobe `bun src/main.ts` como processo do SO separado, em uma porta livre (ou `env.PORT`), e espera /health/live.
 * stdout/stderr vão para $TEST_LOG_DIR (padrão: <tmpdir>/wagering-test-logs)/<name>.log.
 */
export async function spawnInstance(
  env: Record<string, string> = {},
  opts: { name?: string; port?: number; waitLive?: boolean } = {},
): Promise<Instance> {
  mkdirSync(LOG_DIR, { recursive: true });
  const port = opts.port ?? (await freePort());
  const name = `${opts.name ?? 'inst'}-${port}-${Date.now()}`;
  const logFile = `${LOG_DIR}/${name}.log`;
  const fd = openSync(logFile, 'w');
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...baseEnv(), PORT: String(port), INSTANCE_ID: name, ...env } as Record<string, string>,
    stdout: fd,
    stderr: fd,
    stdin: 'ignore',
  });
  closeSync(fd);
  const instance: Instance = {
    name,
    url: `http://127.0.0.1:${port}`,
    port,
    proc,
    logFile,
    exited: proc.exited,
    async kill(signal: NodeJS.Signals | number = 'SIGKILL') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await proc.exited;
      return { exitCode: proc.exitCode, signalCode: proc.signalCode };
    },
    readLog: () => Bun.file(logFile).text(),
  };
  spawned.add(instance);
  if (opts.waitLive !== false) {
    try {
      await waitFor(
        async () => {
          if (proc.exitCode !== null) throw new Error(`process exited early with ${proc.exitCode}: ${(await instance.readLog()).slice(-800)}`);
          const res = await fetch(`${instance.url}/health/live`).catch(() => undefined);
          return res?.ok === true;
        },
        30_000,
        `${name} /health/live`,
        150,
      );
    } catch (e) {
      await instance.kill('SIGKILL');
      throw e;
    }
  }
  return instance;
}

/** Limpeza de último recurso para que um teste que falha nunca deixe processos filhos rodando. */
export async function killAllInstances(): Promise<void> {
  for (const i of spawned) {
    if (i.proc.exitCode === null && i.proc.signalCode === null) i.proc.kill('SIGKILL');
  }
  await Promise.all([...spawned].map((i) => i.proc.exited.catch(() => undefined)));
  spawned.clear();
  await sleep(0);
}

process.on('exit', () => {
  for (const i of spawned) {
    try {
      if (i.proc.exitCode === null && i.proc.signalCode === null) i.proc.kill('SIGKILL');
    } catch {
      /* ignora */
    }
  }
});

/** Aciona o consumer em processo manualmente até a fila ficar vazia (apagada, não apenas oculta). */
export async function pumpConsumer(
  consumer: { pollOnce(): Promise<number> },
  queueUrl: string,
  queueTotal: (url: string) => Promise<number>,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let received = 0;
  for (;;) {
    received += await consumer.pollOnce();
    if ((await queueTotal(queueUrl)) === 0) return received;
    if (Date.now() > deadline) throw new Error(`queue ${queueUrl} not drained after ${timeoutMs}ms`);
  }
}
