import { randomUUID } from 'node:crypto';

/** Todas as wallets criadas por este helper no processo de teste atual (usado na limpeza). */
export const createdWalletIds: string[] = [];

export interface Money {
  amount: string;
  currency: string;
}

export interface WalletRef {
  id: string;
  playerId: string;
  currency: string;
}

export interface TxRequest {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface TxResponse {
  status: number;
  body: any;
}

export async function createWallet(baseUrl: string, amount = '100.00', currency = 'BRL'): Promise<WalletRef> {
  const playerId = randomUUID();
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  createdWalletIds.push(body.id);
  return { id: body.id, playerId, currency };
}

let counter = 0;

/** Monta a requisição com ids novos; o `provider` é separado por chamada para que as chaves nunca colidam entre testes. */
export function buildTx(
  wallet: WalletRef,
  kind: TxRequest['kind'],
  amount: string,
  extra: Partial<TxRequest> = {},
): TxRequest {
  const providerId = extra.providerId ?? 'provider-t';
  const externalTransactionId = extra.externalTransactionId ?? `ext-${randomUUID()}-${counter++}`;
  return {
    idempotencyKey: extra.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: extra.roundId ?? `round-${randomUUID().slice(0, 8)}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: wallet.currency },
    ...(extra.referenceExternalTransactionId ? { referenceExternalTransactionId: extra.referenceExternalTransactionId } : {}),
  };
}

export async function submit(baseUrl: string, tx: TxRequest): Promise<TxResponse> {
  const { idempotencyKey, ...body } = tx;
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Igual ao submit, mas em erro de rede ou 5xx tenta a próxima base URL com a MESMA idempotency key (retry real de provider). */
export async function submitWithFailover(baseUrls: string[], tx: TxRequest, start = 0, attempts = 12): Promise<TxResponse> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const url = baseUrls[(start + i) % baseUrls.length]!;
    try {
      const r = await submit(url, tx);
      if (r.status < 500) return r;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`submitWithFailover exhausted: ${String(last)}`);
}

export async function getJson<T = any>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

export async function getWallet(baseUrl: string, id: string): Promise<{ id: string; balance: Money; version: number }> {
  const r = await getJson(`${baseUrl}/wallets/${id}`);
  if (r.status !== 200) throw new Error(`getWallet ${r.status}`);
  return r.body;
}

export function toSqsData(tx: TxRequest) {
  return {
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
  };
}
