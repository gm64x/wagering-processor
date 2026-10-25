/**
 * Teste de carga (bun run test:load). Não sobe nada: aciona instâncias já rodando
 * (o docker compose com 3 instâncias, ou processos `PORT=300x bun src/main.ts`).
 *
 *   LOAD_TARGETS       URLs base separadas por vírgula       (padrão http://localhost:3001,http://localhost:3002,http://localhost:3003)
 *   LOAD_WALLETS       K carteiras a criar                   (padrão 50)
 *   LOAD_DURATION_S    D segundos de tráfego                 (padrão 20)
 *   LOAD_CONCURRENCY   C clientes concorrentes               (padrão 64)
 *   LOAD_HOT_PERCENT   % das requisições direcionadas à carteira #0 (padrão 20; mostra contenção em uma carteira só)
 *   LOAD_REPLAY_PERCENT % das requisições que reenviam uma requisição anterior sem alterações (padrão 5)
 *   LOAD_INITIAL_BALANCE                                     (padrão 1000000.00)
 *   LOAD_OUT           também grava o relatório em markdown neste arquivo
 *   DATABASE_URL       Postgres usado na reconciliação e no lag do outbox (padrão o banco do compose local)
 *
 * Mix de operações: ~55% BET, 20% WIN, 10% LOSS, 10% REFUND (de uma BET PROCESSED anterior), o resto replays.
 * Depois, cada carteira é reconciliada de três formas: o endpoint /reconciliation do próprio serviço, uma checagem SQL
 * (saldo armazenado == créditos - débitos) e o saldo previsto a partir dos resultados que o cliente observou.
 */
import { randomUUID } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';

const TARGETS = (process.env.LOAD_TARGETS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const K = Number(process.env.LOAD_WALLETS ?? 50);
const D = Number(process.env.LOAD_DURATION_S ?? 20);
const C = Number(process.env.LOAD_CONCURRENCY ?? 64);
const HOT_PERCENT = Number(process.env.LOAD_HOT_PERCENT ?? 20);
const REPLAY_PERCENT = Number(process.env.LOAD_REPLAY_PERCENT ?? 5);
const INITIAL = process.env.LOAD_INITIAL_BALANCE ?? '1000000.00';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';
interface Wallet {
  id: string;
  playerId: string;
  refundable: Array<{ external: string; round: string; cents: number }>;
  expectedCents: number;
}
interface SentRequest {
  walletIdx: number;
  key: string;
  body: Record<string, unknown>;
  transactionId?: string;
}

const cents = (amount: string): number => Math.round(Number(amount) * 100);
const money = (c: number): string => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const first = <T>(rows: unknown): T => (rows as T[])[0] as T;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main(): Promise<void> {
  const sql = new Bun.SQL(DATABASE_URL);
  const lines: string[] = [];
  const out = (s = ''): void => {
    lines.push(s);
    console.log(s);
  };

  for (const t of TARGETS) {
    const r = await fetch(`${t}/health/ready`).catch(() => undefined);
    if (!r?.ok) throw new Error(`target ${t} is not ready (${r?.status ?? 'unreachable'})`);
  }

  // espera o backlog antigo do outbox (execuções e testes anteriores) para que o lag reportado pertença a esta execução
  const drainDeadline = Date.now() + 60_000;
  while (Date.now() < drainDeadline) {
    const { n } = first<{ n: number }>(await sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    if (n === 0) break;
    await sleep(500);
  }

  // ---- carteiras
  const wallets: Wallet[] = [];
  let rr = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (wallets.length < K) {
        const playerId = randomUUID();
        const r = await postJson(`${TARGETS[rr++ % TARGETS.length]}/wallets`, { playerId, initialBalance: { amount: INITIAL, currency: 'BRL' } });
        if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.body)}`);
        wallets.push({ id: r.body.id, playerId, refundable: [], expectedCents: cents(INITIAL) });
      }
    }),
  );
  wallets.length = K; // os workers podem passar de K por algumas criações ao correr na checagem do length

  // ---- tráfego
  const latencies: number[] = [];
  const byHttp = new Map<string, number>();
  const byResult = new Map<string, number>();
  const byKind = new Map<string, number>();
  const sent: SentRequest[] = [];
  const seenTx = new Set<string>();
  let replaysExpected = 0;
  let replaysConfirmed = 0;
  let networkErrors = 0;
  let completed = 0;
  const stopAt = Date.now() + D * 1000;
  const started = performance.now();
  let target = 0;

  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

  async function one(): Promise<void> {
    const url = TARGETS[target++ % TARGETS.length]!;
    // replay de uma requisição anterior, sem alterações
    if (sent.length > 100 && Math.random() * 100 < REPLAY_PERCENT) {
      const prev = pick(sent);
      replaysExpected++;
      const t0 = performance.now();
      try {
        const r = await postJson(`${url}/wagering/transactions`, prev.body, { 'idempotency-key': prev.key });
        latencies.push(performance.now() - t0);
        bump(byHttp, String(r.status));
        bump(byKind, 'REPLAY');
        if (r.body?.idempotentReplay === true && r.body.transactionId === prev.transactionId) replaysConfirmed++;
        else if (r.status >= 500) replaysExpected--; // erro de infraestrutura: nem confirmado nem refutado
      } catch {
        networkErrors++;
        replaysExpected--;
      }
      return;
    }
    const walletIdx = Math.random() * 100 < HOT_PERCENT ? 0 : Math.floor(Math.random() * wallets.length);
    const w = wallets[walletIdx]!;
    const roll = Math.random() * 100;
    let kind: Kind = roll < 55 ? 'BET' : roll < 75 ? 'WIN' : roll < 85 ? 'LOSS' : 'REFUND';
    let refund: Wallet['refundable'][number] | undefined;
    if (kind === 'REFUND') {
      refund = w.refundable.pop();
      if (!refund) kind = 'BET';
    }
    const external = `load-${randomUUID()}`;
    const amountCents = kind === 'LOSS' ? 0 : kind === 'REFUND' ? refund!.cents : 100 + Math.floor(Math.random() * 4900);
    const body: Record<string, unknown> = {
      providerId: 'load-provider',
      externalTransactionId: external,
      playerId: w.playerId,
      walletId: w.id,
      roundId: refund?.round ?? `round-${randomUUID().slice(0, 8)}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount: money(amountCents), currency: 'BRL' },
      ...(refund ? { referenceExternalTransactionId: refund.external } : {}),
    };
    const key = `load-provider:${external}`;
    const t0 = performance.now();
    try {
      const r = await postJson(`${url}/wagering/transactions`, body, { 'idempotency-key': key });
      latencies.push(performance.now() - t0);
      bump(byHttp, String(r.status));
      bump(byKind, kind);
      const status: string = r.body?.status ?? `HTTP_${r.status}`;
      bump(byResult, status);
      const txId: string | undefined = r.body?.transactionId;
      if (txId) {
        sent.push({ walletIdx, key, body, transactionId: txId });
        if (!seenTx.has(txId) && status === 'PROCESSED') {
          seenTx.add(txId);
          if (kind === 'BET') {
            w.expectedCents -= amountCents;
            w.refundable.push({ external, round: body.roundId as string, cents: amountCents });
          } else if (kind === 'WIN' || kind === 'REFUND') w.expectedCents += amountCents;
        }
      }
    } catch {
      networkErrors++;
    }
    completed++;
  }

  const client = async (): Promise<void> => {
    while (Date.now() < stopAt) await one();
  };
  await Promise.all(Array.from({ length: C }, client));
  const elapsedS = (performance.now() - started) / 1000;

  // ---- lag do outbox: quanto tempo até tudo que esta execução produziu ser publicado
  const lagStart = performance.now();
  const { pending, oldest } = first<{ pending: number; oldest: number }>(await sql`
    SELECT COUNT(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float AS oldest
    FROM outbox_messages WHERE published_at IS NULL`);
  const hotPending = first<{ n: number }>(await sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL AND aggregate_id = ${wallets[0]!.id}`).n;
  let hotDrainS: number | undefined;
  let drainS = 0;
  for (;;) {
    if (hotDrainS === undefined) {
      const h = first<{ n: number }>(await sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL AND aggregate_id = ${wallets[0]!.id}`).n;
      if (h === 0) hotDrainS = (performance.now() - lagStart) / 1000;
    }
    const { n } = first<{ n: number }>(await sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    drainS = (performance.now() - lagStart) / 1000;
    if (n === 0 || drainS > 120) break;
    await sleep(250);
  }
  const { total_events } = first<{ total_events: number }>(await sql`SELECT COUNT(*)::int AS total_events FROM outbox_messages WHERE aggregate_id = ANY(${wallets.map((w) => w.id)})`);

  // ---- reconciliação
  let apiInconsistent = 0;
  let apiMismatchExpected = 0;
  for (const w of wallets) {
    const r = await postJson(`${TARGETS[0]}/wallets/${w.id}/reconciliation`, {});
    if (r.status !== 200 || r.body.consistent !== true) apiInconsistent++;
    if (cents(r.body?.storedBalance?.amount ?? '0') !== w.expectedCents) apiMismatchExpected++;
  }
  const ids = wallets.map((w) => w.id);
  const [sqlCheck] = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE w.balance_amount <> COALESCE(l.rebuilt, 0))::int AS diverged,
      COUNT(*) FILTER (WHERE w.balance_amount < 0)::int AS negative
    FROM wallets w
    LEFT JOIN (SELECT wallet_id,
                      SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS rebuilt
               FROM wallet_ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id
    WHERE w.id = ANY(${ids})`) as Array<{ diverged: number; negative: number }>;
  const [dupes] = (await sql`
    SELECT COUNT(*)::int AS n FROM (
      SELECT transaction_id, wallet_id FROM wallet_ledger_entries WHERE wallet_id = ANY(${ids}) GROUP BY 1, 2 HAVING COUNT(*) > 1) d`) as Array<{ n: number }>;
  const [txStats] = (await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
           COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
           COUNT(*) FILTER (WHERE status IN ('PENDING','PENDING_REFERENCE'))::int AS pending
    FROM wager_transactions WHERE wallet_id = ANY(${ids}) AND kind <> 'OPENING'`) as Array<{ total: number; processed: number; rejected: number; pending: number }>;
  const [dbConns] = (await sql`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`) as Array<{ n: number }>;
  await sql.close();

  // ---- relatório
  const sorted = [...latencies].sort((a, b) => a - b);
  const ok = apiInconsistent === 0 && sqlCheck!.diverged === 0 && sqlCheck!.negative === 0 && dupes!.n === 0 && apiMismatchExpected === 0;
  const fmtMap = (m: Map<string, number>): string =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(', ') || '-';
  const ms = (n: number): string => n.toFixed(1);
  const requests = latencies.length;

  out(`## Teste de carga`);
  out();
  out(`| Parâmetro | Valor |`);
  out(`|---|---|`);
  out(`| Alvos | ${TARGETS.join(', ')} |`);
  out(`| Carteiras (K) | ${K} (${HOT_PERCENT}% do tráfego na carteira #0) |`);
  out(`| Duração (D) | ${D}s (medido ${elapsedS.toFixed(1)}s) |`);
  out(`| Concorrência (C) | ${C} |`);
  out(`| Host | ${cpus().length} CPU (${cpus()[0]?.model ?? '?'}), ${(totalmem() / 2 ** 30).toFixed(1)} GiB de RAM (${(freemem() / 2 ** 30).toFixed(1)} GiB livres ao final) |`);
  out(`| Runtime | Bun ${Bun.version} |`);
  out();
  out(`| Métrica | Resultado |`);
  out(`|---|---|`);
  out(`| Requisições concluídas | ${requests} |`);
  out(`| Vazão | ${(requests / elapsedS).toFixed(0)} req/s |`);
  out(`| Latência p50 / p95 / p99 / máx | ${ms(percentile(sorted, 50))} / ${ms(percentile(sorted, 95))} / ${ms(percentile(sorted, 99))} / ${ms(sorted.at(-1) ?? 0)} ms |`);
  out(`| Status HTTP | ${fmtMap(byHttp)} |`);
  out(`| Taxa de erro (5xx + rede) | ${(((requests - [...byHttp.entries()].filter(([s]) => Number(s) < 500).reduce((a, [, v]) => a + v, 0) + networkErrors) / Math.max(1, requests + networkErrors)) * 100).toFixed(2)}% (${networkErrors} erros de rede) |`);
  out(`| Mix de operações | ${fmtMap(byKind)} |`);
  out(`| Resultados de negócio | ${fmtMap(byResult)} |`);
  out(`| Replays idempotentes | ${replaysConfirmed}/${replaysExpected} confirmados (idempotentReplay=true, mesmo transactionId) |`);
  out(`| Transações no banco (esta execução) | ${txStats!.total} no total, ${txStats!.processed} processadas, ${txStats!.rejected} rejeitadas, ${txStats!.pending} pendentes |`);
  out(`| Outbox | ${total_events} eventos para estas carteiras; ao fim do tráfego ${pending} pendentes, mais antigo ${oldest.toFixed(2)}s; totalmente esvaziado ${drainS.toFixed(1)}s após o término do tráfego; a carteira quente tinha ${hotPending} pendentes, esvaziados após ${(hotDrainS ?? drainS).toFixed(1)}s |`);
  out(`| Conexões abertas no Postgres | ${dbConns!.n} |`);
  out();
  out(`| Reconciliação | Resultado |`);
  out(`|---|---|`);
  out(`| POST /reconciliation carteiras inconsistentes | ${apiInconsistent} / ${K} |`);
  out(`| SQL: saldo armazenado != créditos - débitos | ${sqlCheck!.diverged} / ${K} |`);
  out(`| SQL: saldos negativos | ${sqlCheck!.negative} |`);
  out(`| SQL: entradas de razão duplicadas por transação | ${dupes!.n} |`);
  out(`| Saldo armazenado != saldo previsto a partir dos resultados observados | ${apiMismatchExpected} / ${K} |`);
  out(`| **Veredito** | **${ok && replaysConfirmed === replaysExpected ? 'APROVADO: todos os invariantes se mantêm' : 'FALHOU'}** |`);

  if (process.env.LOAD_OUT) await Bun.write(process.env.LOAD_OUT, lines.join('\n') + '\n');
  process.exit(ok && replaysConfirmed === replaysExpected ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
