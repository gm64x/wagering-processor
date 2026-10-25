/** Lê um inteiro não-negativo de env; configuração inválida falha no boot (fail fast). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * Loop de background com parada cooperativa: `stop()` pede parada, acorda `sleep()` imediatamente,
 * executa um hook opcional (ex.: abortar long polling) e aguarda o corpo terminar até `drainTimeoutMs`.
 */
export class WorkerLoop {
  private task: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly drainTimeoutMs: number,
    private readonly onDrainTimeout: () => void,
  ) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  start(body: (loop: WorkerLoop) => Promise<void>, onCrash: (err: unknown) => void): void {
    if (this.task) return;
    this.stopping = false;
    this.task = body(this).catch(onCrash);
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }

  async stop(beforeDrain?: () => void): Promise<void> {
    this.stopping = true;
    beforeDrain?.();
    this.wake?.();
    const task = this.task;
    if (!task) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.drainTimeoutMs);
    });
    const drained = await Promise.race([task.then(() => true as const), timedOut]);
    clearTimeout(timer);
    if (!drained) this.onDrainTimeout();
    this.task = undefined;
  }
}
