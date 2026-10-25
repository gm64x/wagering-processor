# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas recebidas de provedores de jogos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), por HTTP ou por fila SQS. O saldo de cada wallet é materializado no PostgreSQL e acompanhado por um ledger imutável. Idempotência, concorrência e entrega de eventos são garantidas pelo banco (índices únicos, `SELECT ... FOR UPDATE`, inbox e transactional outbox), e não por cache em memória nem pela ordenação da fila. Várias instâncias rodam ao mesmo tempo sem estado compartilhado em memória.

As decisões de desenho, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Requisitos

- Docker e Docker Compose v2, para a execução completa em containers.
- Bun 1.4, opcional, apenas para rodar a aplicação e os testes fora do container.

## Início rápido (containers)

```bash
docker compose up -d --build
```

O comando sobe os seguintes serviços:

| Serviço | Papel | Porta no host |
|---|---|---|
| `postgres` | PostgreSQL 16 | 5432 |
| `localstack` | SQS (LocalStack 3.8). Cria as filas no boot via `infra/localstack-init.sh` | 4566 |
| `migrate` | Aplica as migrations e encerra | - |
| `app1`, `app2`, `app3` | Três instâncias idênticas: HTTP, consumidor SQS, publisher de outbox e worker de referências pendentes | 3001, 3002, 3003 |

Confirme que as instâncias estão prontas:

```bash
curl -s http://localhost:3001/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para parar e remover os containers: `docker compose down -v`. O compose não declara volume para o PostgreSQL, então os dados não sobrevivem a um `down`.

## Execução local (sem container da aplicação)

PostgreSQL e LocalStack continuam em containers. A aplicação roda com o Bun instalado na máquina.

```bash
bun install
bun run infra:up        # docker compose up -d postgres localstack
bun run migrate:up
bun run start           # porta 3000 (variável PORT)
```

Os padrões das variáveis já apontam para `localhost` (PostgreSQL em `5432`, LocalStack em `4566`), então um `.env` não é obrigatório. O Bun carrega automaticamente um arquivo `.env` na raiz, e `.env.example` mostra os valores usados neste ambiente. Para recarregar a aplicação a cada alteração, use `bun run dev`.

Para reverter a última migration: `bun run migrate:down`. Cada chamada reverte uma migration.

## Scripts

| Script | Comando | Descrição |
|---|---|---|
| `start` | `bun src/main.ts` | Sobe a aplicação |
| `dev` | `bun --watch src/main.ts` | Sobe a aplicação e reinicia a cada alteração |
| `migrate:up` | `bun scripts/migrate.ts up` | Aplica as migrations pendentes |
| `migrate:down` | `bun scripts/migrate.ts down` | Reverte a última migration |
| `typecheck` | `tsc --noEmit -p .` | Checagem de tipos em modo estrito |
| `test` | `bun test test/unit && bun run test:integration` | Suíte completa (unitários e integração) |
| `test:unit` | `bun test test/unit` | Testes unitários, sem dependências externas |
| `test:integration` | `bun test --timeout 120000 test/integration` | Testes com PostgreSQL e LocalStack reais. Exige `bun run infra:up` |
| `test:load` | `bun scripts/load-test.ts` | Teste de carga. Exige infraestrutura. Resultados em `docs/load-test-results.md` |
| `infra:up` | `docker compose up -d postgres localstack` | Sobe apenas as dependências de infraestrutura |
| `infra:down` | `docker compose down -v` | Derruba todos os serviços do compose e remove volumes |

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP da instância |
| `INSTANCE_ID` | hostname | Identificador da instância, incluído em todos os logs (`instance`) |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` ou `silent`. Valor inválido usa `info` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | Conexão com o PostgreSQL |
| `DB_POOL_MAX` | `20` | Tamanho máximo do pool de conexões por instância (mínimo fixo: 2) |
| `ORM_DEBUG` | desligado | `1` ativa o log de SQL do MikroORM. Não usar em produção: o SQL é logado com parâmetros |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | Região AWS |
| `AWS_ACCESS_KEY_ID` | `test` | Credencial. O LocalStack aceita qualquer valor |
| `AWS_SECRET_ACCESS_KEY` | `test` | Credencial. O LocalStack aceita qualquer valor |
| `SQS_QUEUE_NAME` | `wager-transactions.fifo` | Fila de entrada de transações |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | Dead-letter queue das mensagens de entrada |
| `SQS_EVENTS_QUEUE_NAME` | `wager-events.fifo` | Fila de saída dos eventos de integração |
| `SQS_MAX_RECEIVES` | `5` | Recebimentos antes de mover a mensagem para a DLQ (`MAX_RECEIVES_EXCEEDED`) |
| `SQS_WAIT_SECONDS` | `5` | Duração do long polling do consumidor |
| `SQS_VISIBILITY_BACKOFF_MAX_S` | `60` | Teto, em segundos, do backoff de visibilidade após falha transitória |
| `OUTBOX_POLL_MS` | `500` | Intervalo do publisher de outbox quando não há nada a publicar |
| `PENDING_REF_POLL_MS` | `1000` | Intervalo do worker de referências pendentes |
| `PENDING_REF_BASE_DELAY_MS` | `1000` | Base do backoff exponencial do worker (teto de 60 s) |
| `PENDING_REF_MAX_ATTEMPTS` | `8` | Tentativas antes de rejeitar com `REFERENCE_NOT_FOUND` |
| `WORKERS_ENABLED` | `true` | `false` desliga o consumidor SQS, o publisher de outbox e o worker de referências. A API HTTP continua ativa |
| `FAULT_CRASH_AFTER_COMMIT` | não definida | `1` encerra o processo (código 137) após o commit e antes do ack da mensagem. Uso exclusivo em teste de recuperação |

## Exemplos de uso (curl)

Defina a base e um identificador de jogador. Como todo o estado está no PostgreSQL, qualquer instância responde a qualquer requisição.

```bash
export BASE=http://localhost:3001        # ou 3002, 3003; no modo local, http://localhost:3000
export PLAYER_ID=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
```

### 1. Criar wallet

```bash
curl -s -X POST "$BASE/wallets" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

Resposta (`201`):

```json
{"id":"0192f291-27dd-7d3f-8071-5f8685deef37","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Guarde o `id` retornado. Com `jq` instalado, `export WALLET_ID=$(curl -s ... | jq -r .id)` faz isso automaticamente. Repetir a criação para o mesmo `playerId` e moeda retorna `409 WALLET_ALREADY_EXISTS`. Um saldo inicial maior que zero gera uma transação interna `OPENING` com lançamento de crédito, na mesma transação SQL.

```bash
export WALLET_ID=0192f291-27dd-7d3f-8071-5f8685deef37   # substitua pelo id retornado
```

### 2. Submeter uma aposta (BET)

O header `Idempotency-Key` é obrigatório. O default recomendado é `{providerId}:{externalTransactionId}`.

```bash
curl -s -i -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Resposta (`201`):

```json
{"transactionId":"0192f298-345e-7e38-af88-e43f851a819d","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```

### 3. Replay idempotente

Envie exatamente o mesmo request (mesma `Idempotency-Key` e mesmo corpo). A resposta é o resultado original, com `200` e `idempotentReplay: true`. Nenhum novo débito é gerado.

```json
{"transactionId":"0192f298-345e-7e38-af88-e43f851a819d","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":true}
```

### 4. Conflito de idempotência

Mesma chave com outro valor (por exemplo `"money":{"amount":"30.00",...}`) retorna `409`:

```json
{"error":{"code":"IDEMPOTENCY_KEY_CONFLICT","message":"Idempotency-Key was already used with a different payload"}}
```

O mesmo vale para uma nova chave que reutiliza um `externalTransactionId` já existente para o provedor.

### 5. Rejeição por regra de negócio

Uma aposta sem saldo suficiente é registrada como `REJECTED` (`422`), com o `failureCode` e o saldo observado:

```bash
curl -s -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-124' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-124\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
```

```json
{"transactionId":"...","status":"REJECTED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false,"failureCode":"INSUFFICIENT_FUNDS"}
```

### 6. Reembolso com referência fora de ordem

Um `REFUND` cuja `BET` ainda não chegou é aceito como `PENDING_REFERENCE` (`202`). Quando a aposta chega, o worker de referências pendentes aplica o reembolso automaticamente, normalmente em poucos segundos.

```bash
# REFUND antes da BET: 202 PENDING_REFERENCE
curl -s -i -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-200' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund-200\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"transaction-200\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"

# BET chega depois: 201 PROCESSED
curl -s -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-200' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-200\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

O estado final do reembolso pode ser consultado pelo id externo (próximo item). Se a referência não chegar em cerca de 3 minutos com a configuração padrão, a transação é `REJECTED` com `REFERENCE_NOT_FOUND`.

### 7. Consultar transação

```bash
curl -s "$BASE/wagering/transactions/0192f298-345e-7e38-af88-e43f851a819d"
curl -s "$BASE/providers/provider-a/wagering/transactions/transaction-123"
```

### 8. Saldo da wallet

```bash
curl -s "$BASE/wallets/$WALLET_ID"
```

### 9. Ledger com cursor

```bash
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=2"
# {"items":[...],"nextCursor":"Mg"}

curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=2&cursor=Mg"
# próxima página; "nextCursor": null na última
```

`limit` aceita valores de 1 a 200 (padrão 50). O cursor é opaco, baseado no `seq` do último lançamento, e a ordem é estável (`seq` crescente). Cursor inválido retorna `400 VALIDATION_ERROR`.

### 10. Reconciliação

```bash
curl -s -X POST "$BASE/wallets/$WALLET_ID/reconciliation"
```

Resposta (`200`):

```json
{"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37","storedBalance":{"amount":"75.00","currency":"BRL"},"calculatedBalance":{"amount":"75.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":4}
```

O endpoint não recebe corpo; o id vem da URL. Uma divergência retorna `consistent: false`, é registrada em log de erro e incrementa a métrica `wagering_reconciliation_divergences_total`. O saldo nunca é corrigido automaticamente.

### 11. Health e métricas

```bash
curl -s "$BASE/health/live"     # {"status":"ok"}
curl -s -i "$BASE/health/ready" # 200 se PostgreSQL e SQS responderem; 503 indicando o que caiu
curl -s "$BASE/metrics" | grep '^wagering_'
```

Os endpoints de health e `/metrics` são públicos.

### 12. Enviar transação pela fila SQS

Mensagem (envelope da entrada de transações):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Campos opcionais em `data`: `referenceExternalTransactionId` (obrigatório para `REFUND` e `ROLLBACK`) e `correlationId`. O `MessageGroupId` deve ser o `walletId` (ordem por wallet) e o `MessageDeduplicationId` deve ser o `messageId`.

Envio pelo `awslocal` dentro do container do LocalStack:

```bash
MSG='{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'

docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id 0192f291-27dd-7d3f-8071-5f8685deef37 \
  --message-deduplication-id msg-123 \
  --message-body "$MSG"
```

Com a AWS CLI instalada na máquina, o equivalente é:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id 0192f291-27dd-7d3f-8071-5f8685deef37 \
  --message-deduplication-id msg-123 \
  --message-body "$MSG"
```

Depois do processamento, o resultado aparece na API:

```bash
curl -s "$BASE/providers/provider-a/wagering/transactions/transaction-123"
```

Mensagens que não podem ser processadas (JSON inválido, tipo desconhecido, wallet inexistente) vão para `wager-transactions-dlq.fifo` com o atributo `reason`. Para inspecioná-las:

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --message-attribute-names All
```

## Códigos de resposta HTTP

Todas as respostas ecoam o header `x-correlation-id`. Se o cliente enviar um valor válido (até 128 caracteres de `A-Za-z0-9._:-`), ele é reutilizado; caso contrário, um UUID é gerado. Erros usam o formato `{"error":{"code":"...","message":"..."}}`.

| Status | Situação | Código |
|---|---|---|
| `201` | Transação processada pela primeira vez; wallet criada | - |
| `200` | Replay de transação já processada (`idempotentReplay: true`); consultas; reconciliação | - |
| `202` | Aceita, aguardando a transação de referência (`PENDING_REFERENCE`). Não é erro | - |
| `422` | Rejeitada por regra de negócio (`REJECTED`). O corpo traz o `failureCode` | - |
| `400` | Payload inválido, `Idempotency-Key` ausente ou maior que 512 caracteres, cursor inválido, `kind` `OPENING` | `VALIDATION_ERROR` |
| `404` | Wallet inexistente | `WALLET_NOT_FOUND` |
| `404` | Transação inexistente | `NOT_FOUND` |
| `409` | Mesma chave com payload diferente, ou `(providerId, externalTransactionId)` já usado com outra chave | `IDEMPOTENCY_KEY_CONFLICT` |
| `409` | Wallet já existe para o par `playerId` e moeda | `WALLET_ALREADY_EXISTS` |
| `413` | Corpo da requisição acima de 100 KB (limite padrão do Express) | `PAYLOAD_TOO_LARGE` |
| `500` | Erro interno inesperado. Detalhes são logados, não retornados | `INTERNAL_ERROR` |
| `503` | Falha transitória de infraestrutura (PostgreSQL ou lock indisponível), com `Retry-After: 1`. Reenviar com a mesma chave é seguro | `TRANSIENT_INFRASTRUCTURE` |

## Testes

```bash
bun run test:unit           # unitários: sem dependências externas
bun run infra:up            # PostgreSQL e LocalStack reais em containers
bun run test:integration    # migrations, atomicidade, inbox, outbox, retry/DLQ, recuperação, concorrência HTTP
bun run test:load           # teste de carga; resultados em docs/load-test-results.md
bun run test                # unitários + integração
```

Os testes de integração usam PostgreSQL e LocalStack reais, sem substituir o banco ou a fila por mocks, e incluem cenários de concorrência com múltiplas instâncias. A estratégia completa está em [ARCHITECTURE.md](ARCHITECTURE.md#testes).

## Estrutura do projeto

```
.
├── ARCHITECTURE.md              # decisões, trade-offs e limitações
├── docs/
│   └── load-test-results.md     # resultados e análise do teste de carga
├── Dockerfile                   # imagem da aplicação (oven/bun:1.4)
├── docker-compose.yml           # postgres, localstack, migrate e 3 instâncias
├── .env.example
├── infra/
│   └── localstack-init.sh       # cria as filas FIFO no boot do LocalStack
├── migrations/                  # migrations versionadas e reversíveis (MikroORM)
├── scripts/
│   ├── migrate.ts               # up / down
│   └── load-test.ts             # teste de carga
├── src/
│   ├── main.ts                  # bootstrap, shutdown hooks
│   ├── app.module.ts
│   ├── domain/                  # regras puras: Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos
│   ├── application/             # casos de uso, engine de regras, worker de referências pendentes, portas
│   └── infrastructure/
│       ├── http/                # controllers, validação, filtro de exceções, health, guard de identidade
│       ├── messaging/           # consumidor SQS, publisher de outbox, publisher de eventos, DLQ
│       ├── observability/       # logger (pino), métricas (prom-client), correlation id
│       └── persistence/         # configuração do MikroORM, repositórios SQL, classificação de erros do pg
└── test/
    ├── unit/
    ├── integration/
    └── support/                 # helpers: aplicação, banco, SQS, espera
```
