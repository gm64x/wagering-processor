# Arquitetura

Este documento descreve as decisões de desenho do Wagering Processor, os motivos de cada escolha, os trade-offs assumidos e as limitações conhecidas. Para instruções de execução, ver [README.md](README.md).

## Índice

1. [Visão geral](#visão-geral)
2. [Camadas e boundaries](#camadas-e-boundaries)
3. [Modelo de domínio](#modelo-de-domínio)
4. [Escolha do ORM e estratégia transacional](#escolha-do-orm-e-estratégia-transacional)
5. [Schema e constraints](#schema-e-constraints)
6. [Concorrência](#concorrência)
7. [Idempotência](#idempotência)
8. [Regras de negócio e interpretações](#regras-de-negócio-e-interpretações)
9. [Referências fora de ordem](#referências-fora-de-ordem)
10. [Taxonomia de failure codes](#taxonomia-de-failure-codes)
11. [Mapeamento HTTP](#mapeamento-http)
12. [Mensageria (SQS)](#mensageria-sqs)
13. [Transactional outbox](#transactional-outbox)
14. [Observabilidade](#observabilidade)
15. [Autenticação](#autenticação)
16. [Testes](#testes)
17. [Trade-offs e limitações](#trade-offs-e-limitações)
18. [O que eu faria com mais tempo](#o-que-eu-faria-com-mais-tempo)

---

## Visão geral

O sistema recebe operações de apostas de provedores por dois canais: HTTP (`POST /wagering/transactions`) e fila SQS (`wager-transactions.fifo`). Os dois canais chamam o **mesmo caso de uso** (`WageringService.submit`). Cada operação é aplicada em uma única transação SQL no PostgreSQL, que grava a transação, a alteração de saldo, o lançamento no ledger, o registro de inbox (quando a entrada é SQS) e os eventos de integração na outbox. Só depois do commit os eventos são publicados.

A unidade de concorrência é a `walletId`. Cada transação trava a linha da wallet com `SELECT ... FOR UPDATE`. Não existe lock global, nem estado em memória que garanta correção.

```
  Provedor de jogos
     |                                       |
     | HTTP POST /wagering/transactions      | mensagem em wager-transactions.fifo
     | Idempotency-Key                       | MessageGroupId = walletId
     v                                       v
+------------------+               +---------------------------+
| Controller HTTP  |               | Consumidor SQS            |
+--------+---------+               | (ack somente após commit) |
         |                         +------------+--------------+
         +----------------+---------------------+
                          v
          +-----------------------------------+
          | WageringService.submit()          |  caso de uso único (HTTP e SQS)
          | WagerEngine (regras da seção 7)   |
          +----------------+------------------+
                           | em.fork().transactional(...)  -- uma transação SQL
                           v
  +-------------------------------------------------------------------+
  | PostgreSQL                                                        |
  |  1. inbox_messages          INSERT ... ON CONFLICT DO NOTHING     |  (só SQS)
  |  2. wallets                 SELECT ... FOR UPDATE                 |  lock da wallet
  |  3. wager_transactions      INSERT                                |
  |  4. wallets                 UPDATE ... WHERE version = ?          |  só se o saldo mudou
  |  5. wallet_ledger_entries   INSERT (append-only)                  |  só se o saldo mudou
  |  6. outbox_messages         INSERT (eventos de integração)        |
  +----------------------------------+--------------------------------+
                                     | COMMIT
                                     v
                    +-----------------------------------+
                    | OutboxPublisher (1 por instância) |  FOR UPDATE SKIP LOCKED
                    +----------------+------------------+
                                     | SendMessage
                                     |   MessageGroupId = walletId
                                     |   MessageDeduplicationId = eventId
                                     v
                          wager-events.fifo

  Em cada instância, em paralelo:
  PendingReferenceWorker: reprocessa PENDING_REFERENCE vencidas
  (trava a linha da transação e depois a wallet, usando o mesmo WagerEngine)
```

Cada instância executa os quatro componentes: servidor HTTP, consumidor SQS, publisher de outbox e worker de referências pendentes. `WORKERS_ENABLED=false` desliga os três últimos, o que é útil em testes. O processo é stateless: o estado vive no PostgreSQL e nas filas, o que permite escalar horizontalmente (o compose sobe três instâncias).

---

## Camadas e boundaries

| Camada | Pasta | Conteúdo | Dependências permitidas |
|---|---|---|---|
| Domínio | `src/domain/` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração, hash de payload | Apenas `node:crypto` e outros módulos do domínio. Nenhum import de NestJS, MikroORM ou AWS |
| Aplicação | `src/application/` | `WageringService`, `WalletService`, `WagerEngine`, `PendingReferenceWorker`, DTOs, portas | Domínio, e hoje também os repositórios concretos e o `MikroORM` (ver trade-offs) |
| Infraestrutura | `src/infrastructure/` | `http/`, `messaging/`, `observability/`, `persistence/` | Domínio, aplicação e bibliotecas externas |

O domínio é testado sem nenhuma infraestrutura: os testes unitários cobrem `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, eventos e hash de payload apenas com objetos em memória.

### Portas

| Porta (token) | Interface | Implementação | Usada por |
|---|---|---|---|
| `METRICS` | `Metrics` | `PrometheusMetrics` (prom-client) | Use cases, consumidor, publisher, worker |
| `APP_LOGGER` | `AppLogger` | `PinoAppLogger` | Todos |
| `EVENT_PUBLISHER` | `EventPublisher` | `SqsEventPublisher` | `OutboxPublisher` |
| `CLOCK` | `Clock` | `systemClock` (injetável em teste) | Use cases e worker |
| `PROVIDER_IDENTITY` | `ProviderIdentityPort` | `NoopProviderIdentity` | `ProviderAuthGuard` |

**Trade-off assumido:** os repositórios (`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `OutboxRepository`, `InboxRepository`) não estão atrás de portas. A aplicação os injeta como classes concretas e usa `EntityManager` do MikroORM para abrir a transação. A escolha reduz cerimônia, porque o SQL do caminho financeiro já é específico do PostgreSQL (`FOR UPDATE SKIP LOCKED`, `ON CONFLICT`), e uma porta genérica esconderia justamente o que precisa ser visível. O custo é que trocar de banco exigiria reescrever os repositórios; o domínio não sairia afetado.

---

## Modelo de domínio

### Money

- Valor interno em **`bigint` de centavos** (escala fixa 2). `number`, `float` e `double` não são usados em nenhum ponto do fluxo monetário.
- Imutável: toda operação devolve uma nova instância.
- Entrada (`Money.from`): o valor deve casar com `^(0|[1-9]\d*)(\.\d{1,2})?$`. Valores como `"25"` e `"25.5"` são aceitos e normalizados para `"25.00"` e `"25.50"`. Rejeitados com `InvalidMoneyError`: `NaN`, `Infinity`, notação científica (`"1e5"`), string vazia, mais de duas casas (`"1.234"`), espaços, sinal (`"+1"`, `"-1"`), zeros à esquerda (`"01.00"`) e separador decimal por vírgula.
- No HTTP, JSON numérico (`"amount": 25`) também é rejeitado: o valor precisa ser string decimal.
- Moedas: código ISO-4217 de três letras maiúsculas. Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- Persistência: `NUMERIC(20,2)` com `CHAR(3)` para a moeda. O driver `pg` devolve `numeric` como string, e `Money.fromPersisted` reconstrói o valor exato. Não há conversão para `float` em nenhum ponto.

Exemplo do contrato: `{ "amount": "25.00", "currency": "BRL" }`.

### Wallet (aggregate root)

| Aspecto | Regra |
|---|---|
| Criação | `Wallet.open` com `version = 1`. Saldo inicial não pode ser negativo |
| Reconstrução | `Wallet.rehydrate` reconstrói o estado persistido sem revalidar transições |
| Movimentação | `debit` e `credit` validam moeda, validam saldo (débito) e geram o `WalletLedgerEntry` correspondente |
| Versão | Incrementa **somente** quando o saldo muda. A abertura não incrementa |
| Saldo | Nunca negativo: `canDebit` é checado antes do débito, e o banco impõe `CHECK (balance_amount >= 0)` |
| Unicidade | Uma wallet por `(player_id, currency)`, imposta por constraint |

A versão é usada como segunda barreira de concorrência (`UPDATE ... WHERE version = ?`), descrita em [Concorrência](#concorrência).

### WagerTransaction

Estados e transições (implementadas em `wager-transaction.ts`):

| De \ Para | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
|---|---|---|---|---|
| `PENDING` | sim | sim | sim | sim |
| `PENDING_REFERENCE` | sim (reagenda, incrementa `attempts`) | sim | sim | sim |
| `PROCESSED` | não | não | não | não |
| `REJECTED` | não | não | não | não |
| `FAILED` | não | não | não | não |

`PROCESSED`, `REJECTED` e `FAILED` são **terminais**. Qualquer tentativa de transição a partir deles lança `InvalidTransactionStateError`, que é erro de programação, não caminho de negócio. O banco reforça essa regra com o trigger `trg_wtx_guard` (ver [Schema](#schema-e-constraints)).

Observação sobre o estado `FAILED`: ele está modelado, tem mapeamento HTTP (500) e constraint no banco, mas **nenhum fluxo atual o produz**. O método `fail()` existe no domínio sem chamadores fora dele. Ver [limitações](#trade-offs-e-limitações).

Tipos (`kind`) e comportamento:

| Kind | Efeito no saldo | Lançamento no ledger | Referência | Observação |
|---|---|---|---|---|
| `OPENING` | crédito | `CREDIT` | não | Interno. Criado pela criação da wallet. Não aceito pela API nem pela fila |
| `BET` | débito | `DEBIT` | não | Rejeitada se o saldo for insuficiente |
| `WIN` | crédito | `CREDIT` | opcional (`BET`) | |
| `LOSS` | nenhum | nenhum | opcional (`BET`) | Valor `0.00` aceito. Processada sem ledger e sem `WalletBalanceChanged` |
| `REFUND` | crédito | `CREDIT` | obrigatória (`BET`) | Valor igual ao da referência |
| `ROLLBACK` | inverso da referência | inverso | obrigatória (`BET`, `WIN` ou `REFUND`) | Valor igual ao da referência |

Os valores de referência permitidos vêm de `allowedReferenceKinds()`. Um `ROLLBACK` de `ROLLBACK` não é permitido.

### WalletLedgerEntry (imutável)

- Todos os campos são `readonly`, sem métodos de transição. A imutabilidade é estrutural.
- `create` calcula `balanceAfter` a partir de `balanceBefore ± amount` e lança erro se o valor não for positivo, se as moedas divergirem ou se o saldo resultante ficar negativo.
- Uma transação produz no máximo um lançamento por wallet (`UNIQUE (transaction_id, wallet_id)`).
- O banco impede `UPDATE`, `DELETE` e `TRUNCATE` (triggers, ver [Schema](#schema-e-constraints)).

### Inbox e Outbox

- **`InboxMessage`**: registra `(consumerName, messageId)` como chave primária. Comitar a transação equivale a marcar a mensagem como processada. Duplicata é detectada pelo `INSERT ... ON CONFLICT DO NOTHING`.
- **`OutboxMessage`**: criada por `OutboxMessage.enqueue(event)`, com `id = event.eventId`, `payload = event.toJSON()`, `attempts = 0` e `nextAttemptAt = occurredAt`. Mantém `attempts`, `nextAttemptAt`, `publishedAt` e `lastError`. `scheduleRetry` aplica o backoff descrito na seção de outbox.

### IntegrationEvent

- Classe abstrata `IntegrationEvent<T>` com construtor `protected`. Cada evento é uma subclasse concreta, e `eventType` e `version` ficam no tipo, não em uma string no call site.
- `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`. O payload é JSON estável e versionável.
- `aggregateId` é sempre o `walletId`, que é também o `MessageGroupId` no FIFO.

| Evento | Quando é gerado | Dados principais |
|---|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive `LOSS` | transação, provedor, wallet, jogador, rodada, kind, valor, saldo resultante |
| `WagerTransactionRejected` | Rejeição por regra de negócio, inclusive `REFERENCE_NOT_FOUND` | o mesmo, mais `failureCode` |
| `WalletBalanceChanged` | **Somente** quando o saldo muda | direção, valor, saldo antes e depois, `walletVersion` |
| `WagerTransactionPendingReference` | Primeira vez que a transação entra em `PENDING_REFERENCE` | transação, referência, `attempts`, `nextAttemptAt` |

Os eventos são gravados na mesma transação do efeito que descrevem. A entrega para o FIFO é tratada na seção de [outbox](#transactional-outbox).

---

## Escolha do ORM e estratégia transacional

### Opções consideradas

| Opção | Resultado |
|---|---|
| **MikroORM 6** | Escolhido. Unit of Work transacional (`em.fork().transactional()`), identity map isolado por fork, migrator com migrations TypeScript explícitas |
| TypeORM | Aceito pelo desafio, não escolhido. Suporte a transações e a SQL bruto equivalente, mas a API de Unit of Work é menos explícita |
| Prisma | Fora do escopo do desafio |

### Como o ORM é usado

- **Conexão e pool**: `MikroORM` com `pool.min = 2` e `pool.max = DB_POOL_MAX` (padrão 20), por instância.
- **Transações**: `em.fork().transactional(...)` delimita cada operação financeira. Um fork por requisição ou por item de worker garante que nenhum estado seja compartilhado entre transações.
- **Migrations**: `Migrator` com migrations TypeScript listadas explicitamente em `mikro-orm.config.ts`. Isso funciona da mesma forma no Bun, no container e nos testes.
- **Caminho financeiro**: SQL explícito via `em.execute(sql, params)` dentro da transação. Não há entidades mapeadas do MikroORM.

### Por que SQL explícito no caminho financeiro

O fluxo precisa de controle exato do SQL emitido:

- `SELECT ... FOR UPDATE` na linha da wallet;
- `INSERT ... ON CONFLICT DO NOTHING RETURNING` na inbox;
- `UPDATE ... WHERE id = ? AND version = ? RETURNING id`, em que a linha afetada é a prova de sucesso;
- `FOR UPDATE OF t SKIP LOCKED` na fila de referências pendentes e no publisher de outbox;
- um índice único parcial (`uq_wtx_single_reversal`).

O identity map do ORM não agrega nada num fluxo que toca uma linha de wallet por transação, e entidades mapeadas acoplariam o domínio a decorators. Por isso os repositórios fazem a conversão entre linha e agregado por `rehydrate()` e `toState()`.

### Consequências conhecidas

- `em.execute` não expõe `rowCount` para `INSERT` e `UPDATE` sem `RETURNING`. Regra adotada: todo comando cuja contagem importa usa `RETURNING` e conta as linhas devolvidas.
- Mudanças de schema exigem editar o SQL dos repositórios, além das migrations.
- O mapeamento é código escrito à mão, o que cria duplicação entre `toState` e as linhas do banco. Os testes de integração exercitam esse mapeamento.

### Configuração transacional

| Configuração | Valor | Efeito |
|---|---|---|
| `SET LOCAL lock_timeout = '5s'` | por transação | Lock preso por mais de 5 s vira erro `55P03`, tratado como transitório (503 ou retry). Nada fica pendurado |
| `statement_timeout` | 10 s (global) | Limite para qualquer comando |
| Pool | min 2, max `DB_POOL_MAX` | |

### Classificação de erros do driver

`pg-errors.ts` classifica erros percorrendo a cadeia de causas do MikroORM (`cause`, `original`, `driverError`). Três categorias:

- **Unique violation** (`23505`) com o nome da constraint: usada para detectar corrida entre wallets diferentes.
- **Lock timeout** (`55P03`): conta como conflito de lock.
- **Transitório**: classe `08` (conexão), `40001`, `40P01`, `55P03`, `57014`, `57P01` a `57P03`, `53300`, além de códigos de rede como `ECONNREFUSED` e `ETIMEDOUT`.

Erros de driver são logados apenas com a classe e o SQLSTATE. A mensagem do MikroORM embute o SQL com os parâmetros, e isso inclui valores monetários e ids.

---

## Schema e constraints

Esta seção lista cada constraint do banco e a invariante que ela garante. A regra do desafio é que unicidade, imutabilidade e não-negatividade estejam no schema, não só no código.

Migrations em `migrations/`: `Migration20261025000001_initial` (schema completo) e `Migration20261025000002_outbox_aggregate_index`. Ambas são reversíveis, e a validação foi feita com `migrate:up`, `migrate:down` (duas vezes) e novo `migrate:up`.

### wallets

| Constraint | Invariante |
|---|---|
| `uq_wallets_player_currency UNIQUE (player_id, currency)` | No máximo uma wallet por jogador e moeda |
| `CHECK (balance_amount >= 0)` | Saldo nunca negativo, independentemente do código |
| `CHECK (version >= 1)` | Versão válida desde a criação |
| `CHECK (currency ~ '^[A-Z]{3}$')` | Moeda em formato ISO |

### wager_transactions

| Constraint | Invariante |
|---|---|
| `uq_wtx_idempotency_key UNIQUE (idempotency_key)` | Uma chave de idempotência corresponde a no máximo uma transação |
| `uq_wtx_provider_external UNIQUE (provider_id, external_transaction_id)` | Um id externo de provedor corresponde a no máximo uma transação |
| `ck_wtx_reference_required` | `REFUND` e `ROLLBACK` sempre têm referência |
| `ck_wtx_rejected_has_code` | `REJECTED` e `FAILED` sempre têm `failure_code` |
| `ck_wtx_processed_has_ts` | `PROCESSED` sempre tem `processed_at` |
| `ck_wtx_opening_internal` | `OPENING` só existe com provedor `internal` |
| `CHECK (amount >= 0)` e `CHECK (kind IN ...)`, `CHECK (status IN ...)` | Domínios válidos |
| `uq_wtx_single_reversal` (índice único parcial em `reference_transaction_id` com `kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`) | Uma referência é revertida **no máximo uma vez**, somando REFUND e ROLLBACK |
| `trg_wtx_guard` (trigger `BEFORE UPDATE`) | Transações terminais não mudam mais. Colunas imutáveis (`id`, `idempotency_key`, `payload_hash`, `amount`, `currency`, `kind`, `wallet_id`) não podem ser alteradas |
| `trg_wtx_no_delete` (trigger `BEFORE DELETE`) | Transações não são excluídas |

### wallet_ledger_entries

| Constraint | Invariante |
|---|---|
| `seq bigserial UNIQUE` | Ordem total de inserção para paginação estável |
| `uq_ledger_tx_wallet UNIQUE (transaction_id, wallet_id)` | No máximo um lançamento por transação e wallet |
| `CHECK (amount > 0)` | Lançamento sempre positivo; a direção vem de `direction` |
| `ck_ledger_arithmetic` | `balance_after = balance_before ± amount`, conforme a direção |
| `CHECK (balance_before_amount >= 0)` e `CHECK (balance_after_amount >= 0)` | Saldos nunca negativos no histórico |
| `trg_ledger_immutable` (`BEFORE UPDATE OR DELETE`) | Ledger é append-only |
| `trg_ledger_no_truncate` (`BEFORE TRUNCATE`) | O ledger não pode ser truncado |

### inbox_messages

| Constraint | Invariante |
|---|---|
| `PRIMARY KEY (consumer_name, message_id)` | Uma mensagem é processada no máximo uma vez por consumidor |

### outbox_messages

| Índice | Finalidade |
|---|---|
| `ix_outbox_due (next_attempt_at) WHERE published_at IS NULL` | Busca de linhas vencidas |
| `ix_outbox_pending_by_aggregate (aggregate_id, occurred_at, id) WHERE published_at IS NULL` | Atende o `NOT EXISTS` que preserva a ordem por wallet (ver outbox) |

### Limite do que o schema garante

A invariante global "saldo da wallet = soma do ledger" **não é imposta por constraint**. Uma constraint `CHECK` atua por linha, e a igualdade envolve várias linhas. Ela é garantida pelo código (que grava saldo e lançamento na mesma transação, sob lock) e verificada pelo endpoint de reconciliação e pela invariante final dos testes. Uma constraint `DEFERRABLE` com trigger seria a forma de impô-la no banco; não foi implementada (ver [o que eu faria com mais tempo](#o-que-eu-faria-com-mais-tempo)).

### Identificadores

Todas as chaves primárias são UUID v7 (`uuid`, versão 7). Como são ordenáveis por tempo, os inserts ficam próximos no índice, e a ordem de criação continua visível nos ids.

---

## Concorrência

### Estratégia

**Lock pessimista por linha da wallet**, travado no início da transação:

```sql
SET LOCAL lock_timeout = '5s';
SELECT ... FROM wallets WHERE id = ? FOR UPDATE;   -- lock da wallet
-- releitura de idempotência e regras, sob o lock
-- INSERT da transação, UPDATE do saldo, INSERT do ledger, INSERT da outbox
COMMIT;
```

A wallet é travada **antes** da verificação de idempotência. Isso faz com que "a chave existe?" e "insere" não se intercalem com outra transação da mesma wallet, e que o saldo lido já seja o definitivo. Em `READ COMMITTED`, cada comando após o lock enxerga o que as transações anteriores da wallet comitaram, inclusive o resultado de um `PENDING_REFERENCE` resolvido por outro processo.

### Camadas de defesa

1. `SELECT ... FOR UPDATE` serializa as transações da mesma wallet.
2. `UPDATE wallets SET ... WHERE id = ? AND version = ? RETURNING id` deve afetar exatamente uma linha. Se não afetar, alguém escreveu sem o lock, e a transação é abortada.
3. `CHECK (balance_amount >= 0)` impede saldo negativo mesmo se o código falhasse.
4. `uq_wtx_single_reversal` impede dupla reversão mesmo se a checagem de código falhasse.

### Por que pessimista e não otimista

- Com **locking otimista**, uma wallet "quente" (muitas apostas simultâneas) gera uma tempestade de retries: quase todas as tentativas perdem a corrida e repetem. O custo cresce com a concorrência, e o retry limitado acaba devolvendo erro ao provedor.
- Com **locking pessimista**, as transações da mesma wallet entram em fila no próprio PostgreSQL. A seção crítica é curta (poucos milissegundos), então a fila anda rápido e cada transação executa uma vez.
- O versionamento (`version`) continua existindo como segunda barreira, e não como mecanismo principal.

**Trade-off assumido:** a vazão de uma wallet é limitada pela serialização. Wallets diferentes continuam em paralelo, e o lock é por linha, nunca global.

### Corridas entre wallets diferentes

O lock da wallet não serializa duas requisições de wallets **diferentes** com a mesma chave de idempotência ou o mesmo `(providerId, externalTransactionId)`. Essas corridas são decididas pelos índices únicos:

1. A transação perdedora falha com `23505` na constraint `uq_wtx_idempotency_key` ou `uq_wtx_provider_external`, e sofre rollback completo (inclusive o saldo, se tiver sido alterado).
2. O serviço repete o caso de uso em **uma transação nova**, até 3 vezes. A nova leitura enxerga a transação vencedora, já comitada, e devolve replay ou conflito, conforme o payload.

Como uma referência pertence sempre a uma única wallet, duas reversões da mesma referência são serializadas pelo lock da wallet. O índice `uq_wtx_single_reversal` é a garantia final no banco, caso a checagem de código não seja suficiente.

### Ordem de locks do worker

O worker de referências pendentes trava **primeiro a linha da transação** (com `SKIP LOCKED`, para distribuir o trabalho entre instâncias) e **depois a wallet**. O caminho HTTP/SQS trava apenas a wallet e só **lê** as transações referenciadas, sem travá-las. Não há ciclo de espera entre os dois caminhos, portanto não há deadlock por construção. Cada item do worker roda na sua própria transação, o que evita segurar várias wallets ao mesmo tempo.

### Múltiplas instâncias

Nenhuma decisão de concorrência depende de um processo específico. Locks, índices e a fila de referências pendentes ficam no PostgreSQL, e o compose sobe três instâncias para exercitar isso. A diferença de latência entre instâncias não afeta a correção.

### Métricas de contenção

- `wagering_lock_conflicts_total` conta cada espera por lock de wallet acima de 50 ms e cada `lock_timeout`.
- `wagering_retries_total{component="lock"}` conta os `lock_timeout` que viraram erro transitório.

---

## Idempotência

### Fonte da verdade

- **HTTP**: header `Idempotency-Key` obrigatório, de 1 a 512 caracteres. Ausente retorna `400`.
- **SQS**: `data.idempotencyKey` do envelope. O default recomendado é `{providerId}:{externalTransactionId}`.

A chave é persistida na transação (`UNIQUE`). Não há cache em memória nem outra fonte de verdade.

### payloadHash

É o SHA-256 em hexadecimal do JSON canônico do subconjunto de campos de negócio:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (já normalizado) e `referenceExternalTransactionId`.

**Algoritmo do JSON canônico** (`canonicalJson` em `payload-hash.ts`):

1. Chaves de objetos são ordenadas recursivamente.
2. Não há espaços em branco.
3. Valores `undefined` são omitidos em objetos (em arrays viram `null`, como no `JSON.stringify`).
4. A ordem dos elementos de arrays é preservada.
5. Objetos com `toJSON` (como `Money`) são serializados por ele.

**Excluídos do hash**: o header `Idempotency-Key`, `correlationId`, metadados de transporte da inbox e qualquer campo extra enviado pelo cliente. A seleção dos campos é explícita, então um campo novo não altera o hash por acidente.

**Normalização de dinheiro**: o valor entra no hash já normalizado, então `"25"` e `"25.00"` produzem o mesmo hash (verificado).

Exemplo com a transação do README:

```
canonical: {"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
payloadHash: 629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344
```

### Semântica de replay e conflito

| Situação | Resultado |
|---|---|
| Mesma chave, mesmo hash | **Replay**: devolve o resultado original, com o saldo observado naquele momento (`resultBalance`). `idempotentReplay: true`. Nenhum efeito novo |
| Mesma chave, hash diferente | **Conflito** `409 IDEMPOTENCY_KEY_CONFLICT`. Não é replay |
| Chave nova, mesmo `(providerId, externalTransactionId)` | **Conflito** `409`. Não é replay |
| Replay de `REJECTED` | Mesmo status e corpo originais (`422`) |
| Replay de `PENDING_REFERENCE` | Devolve o estado **atual**: pode já estar `PROCESSED` (`200`) ou ainda pendente (`202`) |

A falha de rede do lado do provedor é tratada pelo mesmo mecanismo: reenviar a mesma requisição devolve o resultado da primeira execução, seja ela bem-sucedida ou não.

### Inbox (entrada SQS)

- Na **mesma transação** do efeito, `INSERT INTO inbox_messages (consumer_name, message_id, ...) ON CONFLICT DO NOTHING RETURNING message_id`. Se nenhuma linha volta, a mensagem já foi processada, e o caso de uso lança `DuplicateMessageError`. O consumidor faz ack sem efeito.
- Como a inbox é gravada na mesma transação, ela só existe se o efeito existir. Mensagens rejeitadas por erro de validação, wallet inexistente ou conflito de idempotência sofrem rollback e **não** deixam linha na inbox. Se uma delas voltar em redelivery, é reavaliada e produz o mesmo resultado determinístico. A exceção é a wallet inexistente, que vai para a DLQ.
- Duas camadas de deduplicação: a inbox (por `messageId`, entrega do SQS) e a idempotência de negócio (por chave, entrega do provedor). Uma mensagem com `messageId` novo e a mesma chave é resolvida pela segunda.

---

## Regras de negócio e interpretações

As regras da seção 7 do desafio foram implementadas como descrito abaixo. Cada item marcado como interpretação é uma decisão que vai além do texto.

| # | Regra | Comportamento | Tipo |
|---|---|---|---|
| 1 | Rejeições de negócio são persistidas | `REJECTED`, `failureCode` e saldo observado ficam gravados para auditoria e replay | Interpretação |
| 2 | Validação e wallet inexistente não são persistidas | Erros `400` e `404` não gravam transação, então não consomem a chave de idempotência | Interpretação |
| 3 | Reversão única por referência | Uma referência é revertida no máximo **uma vez** somando `REFUND` e `ROLLBACK`. Dois créditos (`REFUND` + `ROLLBACK` da mesma `BET`) seriam dupla devolução | Interpretação (mais estrita que "uma vez por tipo") |
| 4 | `ROLLBACK` de `REFUND` | Permitido. Referencia o `REFUND`, que é outra transação, e debita o crédito | Interpretação |
| 5 | `ROLLBACK` de `ROLLBACK` | Não permitido (`REFERENCE_INVALID_KIND`) | Regra |
| 6 | `WIN` e `LOSS` com referência | Opcional, apontando para `BET`. Se informada, passa pelas mesmas validações de referência | Interpretação |
| 7 | `LOSS` | `PROCESSED` sem ledger e sem `WalletBalanceChanged`. Valor `0.00` aceito. Os demais kinds exigem valor positivo | Regra |
| 8 | Referência ausente ou pendente | A transação dependente fica `PENDING_REFERENCE` e é reavaliada pelo worker | Regra |
| 9 | Referência `REJECTED` ou `FAILED` | Rejeição com `REFERENCE_NOT_PROCESSED` | Regra |
| 10 | Referência com atributos divergentes | Wallet, jogador, moeda ou rodada diferentes geram `REFERENCE_MISMATCH` **imediatamente**, mesmo que a referência ainda esteja pendente, porque a divergência nunca vai deixar de existir | Interpretação |
| 11 | Reversão integral | Valor de `REFUND` e `ROLLBACK` deve ser igual ao da referência. Reversão parcial está fora de escopo | Regra |
| 12 | Direção do `ROLLBACK` | Inversa à direção da referência | Regra |
| 13 | Reversão sem saldo | `ROLLBACK` que deixaria o saldo negativo é rejeitado com `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS` (aposta sem saldo), porque são situações operacionais diferentes | Regra |
| 14 | `OPENING` | Interno: provedor `internal`, id externo `opening:<walletId>`, criado na mesma transação da wallet. Não aceito pela API nem pela fila (`400` ou DLQ). Não incrementa a versão. Saldo inicial zero não gera `OPENING` | Regra |
| 15 | Replay devolve o saldo do momento | O resultado original guarda o saldo observado no processamento, não o saldo atual | Regra |
| 16 | Normalização de valores | `"25"` e `"25.00"` são o mesmo payload | Regra |
| 17 | `(providerId, externalTransactionId)` único | Reuso com outra chave é conflito `409`, não replay | Regra |
| 18 | Moeda | Operação em moeda diferente da wallet é `REJECTED` com `CURRENCY_MISMATCH`. O modelo é multimoeda; o teste ponta a ponta usa `BRL` | Regra |
| 19 | Jogador | `playerId` diferente do dono da wallet é `REJECTED` com `WALLET_PLAYER_MISMATCH` | Regra |
| 20 | Reconciliação não corrige | `consistent` é verdadeiro se o saldo armazenado for igual à soma dos créditos menos débitos **e** ao `balance_after` do último lançamento. Divergência é logada (erro), contabilizada e sinalizada, nunca corrigida | Regra |
| 21 | Consequência do `REJECTED` para o provedor | Uma transação rejeitada consome o `externalTransactionId` e a chave. Reprocessar exige nova transação com **novo** `externalTransactionId` | Consequência documentada |

---

## Referências fora de ordem

### Fluxo

1. Uma transação cuja referência está ausente ou ainda pendente é gravada como `PENDING_REFERENCE`, com `attempts = 1` e `nextAttemptAt = agora + PENDING_REF_BASE_DELAY_MS`. Gera o evento `WagerTransactionPendingReference` (uma única vez).
2. O `PendingReferenceWorker` roda a cada `PENDING_REF_POLL_MS` (padrão 1 s). Em cada ciclo, processa até 20 itens. Cada item tem sua própria transação:
   - `SELECT ... FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
   - trava a wallet;
   - reavalia as regras pelo mesmo `WagerEngine` do caminho HTTP/SQS.
3. Se a referência já foi processada, a transação dependente é processada, com os eventos correspondentes. Se ainda não foi, é reagendada com backoff. Os reagendamentos não geram novo evento.

### Backoff e limite

Fórmula: `min(base × 2^(attempts − 1), 60 s)`, com `base = PENDING_REF_BASE_DELAY_MS` (padrão 1 s) e limite de `PENDING_REF_MAX_ATTEMPTS` (padrão 8).

Sequência com os padrões (instantes contados a partir do submit):

| Avaliação | Instante (s) | `attempts` ao avaliar | Resultado |
|---|---|---|---|
| submit | 0 | 0 → 1 | `PENDING_REFERENCE`; próxima avaliação em 1 s |
| 1 | 1 | 1 → 2 | próxima em 2 s |
| 2 | 3 | 2 → 3 | próxima em 4 s |
| 3 | 7 | 3 → 4 | próxima em 8 s |
| 4 | 15 | 4 → 5 | próxima em 16 s |
| 5 | 31 | 5 → 6 | próxima em 32 s |
| 6 | 63 | 6 → 7 | próxima em 60 s (teto) |
| 7 | 123 | 7 → 8 | próxima em 60 s (teto) |
| 8 | 183 | 8 | `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected` |

Ou seja, com os padrões, a janela até a rejeição é de **183 s (cerca de 3 minutos)**. A janela é configurável por `PENDING_REF_BASE_DELAY_MS` e `PENDING_REF_MAX_ATTEMPTS`.

**Justificativa:** provedores normalmente entregam a referência em segundos. Uma janela de minutos cobre redelivery e reprocessamentos curtos de DLQ, sem deixar transações penduradas indefinidamente.

### Falhas durante o reprocessamento

- Se o worker morrer no meio de um item, a transação do item sofre rollback. A linha continua `PENDING_REFERENCE` e é retomada no próximo ciclo, por qualquer instância.
- Falha de banco em um item encerra apenas aquele item. O restante do lote segue, e itens com falha são excluídos da mesma rodada.

---

## Taxonomia de failure codes

Cada rejeição carrega um `failureCode` estável e legível por máquina. A coluna da direita indica a ação recomendada ao provedor.

Ao reenviar, lembre-se de que uma rejeição fica registrada com a chave e o `externalTransactionId` (ver regra 21). Corrigir o payload exige nova transação com novo id.

| `failureCode` | Quando ocorre | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` com saldo insuficiente | **Desistir** da aposta. Reenviar com a mesma chave devolve o mesmo resultado. Nova aposta, com novo id, só faz sentido após o saldo mudar |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` que deixaria o saldo negativo | **Não reenviar**. Tratar como pendência operacional: o crédito original já foi consumido |
| `CURRENCY_MISMATCH` | Moeda da operação diferente da wallet | **Corrigir payload** (moeda) e enviar nova transação |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da wallet | **Corrigir payload** (identificadores) e enviar nova transação |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro da janela de retries (cerca de 3 min) | Verificar se a referência foi enviada. Se foi, emitir nova transação com novo id. Se não, tratar como falha de integração |
| `REFERENCE_MISMATCH` | Provedor, jogador, wallet, moeda ou rodada da referência diferem | **Não reenviar**: a divergência é permanente. Corrigir os dados na origem |
| `REFERENCE_INVALID_KIND` | Tipo de referência não permitido (por exemplo, `REFUND` de `WIN`) | **Corrigir payload** |
| `REFERENCE_NOT_PROCESSED` | Referência está `REJECTED` ou `FAILED` | **Não reenviar**: não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida por `REFUND` ou `ROLLBACK` | **Não reenviar**. Tratar como concluído |
| `AMOUNT_MISMATCH` | Valor de `REFUND` ou `ROLLBACK` diferente da referência | **Corrigir payload**: a reversão é sempre integral |
| `PROCESSING_FAILED` | Status `FAILED` (erro permanente auditável) | **Não reenviar**; investigar. Modelado, mas nenhum fluxo atual o produz |

Códigos de erro de API (sem transação gravada):

| Código HTTP | `code` | O provedor deve |
|---|---|---|
| 400 | `VALIDATION_ERROR` | **Corrigir payload** ou o header |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Usar a chave original com o payload original, ou uma nova chave com nova transação |
| 409 | `WALLET_ALREADY_EXISTS` | Usar a wallet existente |
| 404 | `WALLET_NOT_FOUND`, `NOT_FOUND` | Verificar o identificador |
| 503 | `TRANSIENT_INFRASTRUCTURE` | **Reenviar com a mesma chave** após `Retry-After`. É seguro: a operação é idempotente |
| 500 | `INTERNAL_ERROR` | Reenviar com a mesma chave. Reportar se persistir |

---

## Mapeamento HTTP

### Status por resultado de `POST /wagering/transactions`

| Resultado | Status | Corpo | Por que este status |
|---|---|---|---|
| `PROCESSED` (novo) | **201** | resultado | Recurso criado: uma transação foi registrada |
| `PROCESSED` (replay) | **200** | resultado com `idempotentReplay: true` | Nenhum recurso novo. O corpo é idêntico, exceto pela flag |
| `PENDING_REFERENCE` (novo ou replay) | **202** | resultado | Aceito, mas o processamento não terminou. Não é erro: o cliente deve consultar o estado |
| `REJECTED` (novo ou replay) | **422** | resultado com `failureCode` | Sintaxe válida, mas a regra de negócio recusou. `409` foi reservado para conflito de idempotência, e `402` tem semântica de pagamento |
| `FAILED` | **500** | resultado | Erro permanente de processamento. O corpo com status terminal sinaliza que reenviar não muda o resultado. Nenhum fluxo atual produz esse status |

### Demais status

| Situação | Status | Código | Por que |
|---|---|---|---|
| Payload malformado, tipos errados, `Idempotency-Key` ausente, `kind` `OPENING`, cursor inválido | 400 | `VALIDATION_ERROR` | Erro de formato, antes de qualquer regra de negócio |
| Wallet ou transação inexistente | 404 | `WALLET_NOT_FOUND` ou `NOT_FOUND` | Recurso não existe |
| Chave com payload diferente, ou id externo reutilizado | 409 | `IDEMPOTENCY_KEY_CONFLICT` | Conflito com estado existente |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` | Conflito com estado existente |
| Corpo acima de 100 KB | 413 | `PAYLOAD_TOO_LARGE` | Limite padrão do body-parser do Express |
| Falha transitória (conexão, lock, serialização) | 503 | `TRANSIENT_INFRASTRUCTURE` | Indisponibilidade temporária. `Retry-After: 1` e a operação é segura de reenviar |
| Erro inesperado | 500 | `INTERNAL_ERROR` | Detalhes vão para o log, não para a resposta |
| Provedor autenticado diferente do `providerId` (quando a auth estiver ativa) | 403 | `PROVIDER_MISMATCH` | Ver [autenticação](#autenticação) |

Todas as respostas de erro usam `{"error":{"code":"...","message":"..."}}`. A mensagem é truncada em 300 caracteres. Todas as respostas ecoam `x-correlation-id`.

`POST /wallets/:id/reconciliation` responde `200` sempre que a reconciliação roda. Divergência aparece no corpo (`consistent: false`), não no status.

---

## Mensageria (SQS)

### Filas

| Fila | Papel | Atributos relevantes |
|---|---|---|
| `wager-transactions.fifo` | Entrada de transações | FIFO, `VisibilityTimeout = 30`, `RedrivePolicy` com `maxReceiveCount = 5` (rede de segurança) |
| `wager-transactions-dlq.fifo` | Dead-letter da entrada | FIFO, sem deduplicação por conteúdo |
| `wager-events.fifo` | Saída dos eventos de integração | FIFO, `MessageGroupId = walletId`, `MessageDeduplicationId = eventId` |

Filas criadas na inicialização do LocalStack por `infra/localstack-init.sh`.

### Consumidor

- **Long polling** de `SQS_WAIT_SECONDS` (padrão 5 s), até 10 mensagens por lote, com `ApproximateReceiveCount` e `MessageGroupId` como atributos de sistema.
- **Ordenação**: mensagens com o mesmo `MessageGroupId` são processadas em sequência. Grupos diferentes são processados em paralelo.
- **Falha no meio de um grupo**: a mensagem que falhou volta para a fila com o mesmo atraso, e as seguintes do grupo também voltam com esse atraso. Assim nenhuma mensagem do grupo é processada fora da ordem.
- **Envelope** validado (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data`). Qualquer desvio é `ValidationError`.
- **Mapeamento**: `toSubmitCommand` gera o mesmo `SubmitWagerTransactionCommand` do HTTP, com `inbox: { consumerName: 'wager-transactions-consumer', messageId }`.

### Classificação de erros

| Resultado | Exemplos | Ação | Métrica |
|---|---|---|---|
| **Ack** (sucesso) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` | `DeleteMessage` **após** o commit | `wagering_transactions_total` |
| **Ack** (duplicata) | `DuplicateMessageError` (inbox) | `DeleteMessage` sem efeito | `wagering_duplicates_detected_total{source="sqs"}` |
| **Ack** (conflito) | `IdempotencyConflictError` | `DeleteMessage` com log de aviso | Log `warn` |
| **Retry** | `TransientInfrastructureError` e erros desconhecidos | `ChangeMessageVisibility` com `min(2^receiveCount, 60)` s | `wagering_retries_total{component="sqs"}` |
| **DLQ** após limite | `receiveCount >= SQS_MAX_RECEIVES` | Envio para a DLQ com `reason = MAX_RECEIVES_EXCEEDED`, depois `DeleteMessage` | `wagering_dlq_messages_total{reason}` |
| **DLQ** permanente | JSON inválido, envelope inválido, `ValidationError`, `WalletNotFoundError`, tipo desconhecido, `OPENING` | Envio para a DLQ com `reason` e `sourceQueue`, depois `DeleteMessage` | `wagering_dlq_messages_total{reason}` |

Com os padrões, uma mensagem transitória é tentada até 5 recebimentos. Os retries acontecem após 2 s, 4 s, 8 s e 16 s, e a DLQ é usada no quinto recebimento. Se o envio para a DLQ falhar, a mensagem original **não** é apagada: volta para a fila com atraso de 5 s.

**Trade-off:** `IdempotencyConflictError` recebe ack e fica registrado apenas em log de aviso. Ela não vai para a DLQ, o que a torna invisível para ferramentas de reprocessamento. A alternativa, mandá-la para a DLQ, aumentaria o volume na DLQ com mensagens que não podem ser reprocessadas sem decisão humana. A escolha foi manter a DLQ para falhas que um reprocessamento pode resolver.

### Ack somente após commit

O `DeleteMessage` acontece depois que `submit` retorna, ou seja, depois do commit. Se o processo morrer entre o commit e o delete, a mensagem reaparece e é tratada como duplicata pela inbox, que faz o ack sem efeito. O teste de injeção de falha (`FAULT_CRASH_AFTER_COMMIT=1`) encerra o processo exatamente nesse intervalo.

### Shutdown gracioso (SIGTERM)

- O `Dockerfile` usa a forma `exec` (`CMD ["bun", "src/main.ts"]`), então o Bun é o PID 1 e recebe o SIGTERM diretamente.
- `app.enableShutdownHooks()` dispara `onModuleDestroy` no consumidor, que:
  1. aborta apenas o long polling em andamento;
  2. espera as mensagens em processamento terminarem, por até 10 s;
  3. devolve à fila (`ChangeMessageVisibility` com 0 s) as mensagens recebidas que ainda não começaram.
- O publisher de outbox usa o mesmo limite de 10 s e termina o lote em andamento. O worker de referências não agenda novos ciclos e aguarda o item em andamento terminar, sem limite de tempo, porque cada item é uma transação curta.

### FIFO como otimização

O `MessageGroupId = walletId` preserva a ordem por wallet **quando o broker a mantém**. A correção não depende disso: o banco é quem garante as invariantes, com lock de wallet e constraints. Uma mensagem fora de ordem gera `PENDING_REFERENCE`, não saldo incorreto.

**Achado durante o desenvolvimento:** o LocalStack 3.8 não preserva o bloqueio de grupo FIFO após `ChangeMessageVisibility`, comportamento que o SQS real preserva. Por isso a ordenação por grupo não deve ser tratada como garantia nos testes locais. A correção não é afetada.

---

## Transactional outbox

### Por que existe

A publicação de um evento é uma escrita em outro sistema (SQS). Se fosse feita dentro da transação financeira, um erro no SQS desfaria um efeito válido, ou o SQS poderia confirmar um evento cuja transação foi revertida. A outbox resolve os dois casos: o evento é gravado no mesmo banco, na mesma transação do efeito, e publicado depois do commit.

### Escrita

Em `WagerEngine.settle`, na mesma transação do efeito, são inseridos os eventos aplicáveis:

- `WagerTransactionProcessed` para qualquer transação processada, inclusive `LOSS`;
- `WalletBalanceChanged` somente quando o saldo muda;
- `WagerTransactionRejected` para rejeições;
- `WagerTransactionPendingReference` na primeira entrada em `PENDING_REFERENCE`.

Na criação da wallet com saldo inicial, a outbox recebe `WagerTransactionProcessed` e `WalletBalanceChanged` do `OPENING`.

### Algoritmo do publisher

Cada instância roda um loop com `OUTBOX_POLL_MS` (padrão 500 ms). Quando um lote é publicado, o loop não espera; quando não há nada a publicar, espera o intervalo. Um lote é uma transação:

```sql
SELECT ... FROM outbox_messages o
WHERE o.published_at IS NULL
  AND o.next_attempt_at <= now()
  AND NOT EXISTS (
    SELECT 1 FROM outbox_messages p
    WHERE p.aggregate_id = o.aggregate_id
      AND p.published_at IS NULL
      AND (p.occurred_at, p.id) < (o.occurred_at, o.id)
  )
ORDER BY o.occurred_at, o.id
LIMIT 50
FOR UPDATE OF o SKIP LOCKED;
```

Depois, para cada linha:

- **Sucesso**: `SendMessage` no `wager-events.fifo`, com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`. Em seguida, `published_at = agora`.
- **Falha**: `attempts + 1`, `next_attempt_at = agora + min(2^(attempts − 1) s, 5 min)` e `last_error`. O processamento segue para a próxima linha.

O commit do lote acontece no fim. A métrica `wagering_outbox_lag_seconds` registra `agora − min(occurred_at)` das linhas pendentes após cada lote.

### Vários publishers

- `FOR UPDATE OF o SKIP LOCKED` garante que dois publishers nunca peguem a mesma linha ao mesmo tempo.
- O `NOT EXISTS` garante **ordem por agregado**: uma linha só é elegível se for a pendente mais antiga da sua wallet. Enquanto o evento N de uma wallet está em voo, o evento N+1 não é elegível para nenhum outro publisher, porque a linha N ainda aparece como pendente na leitura desses publishers. Quando o publisher de N comita, o N+1 passa a ser elegível.

### Ordem e falhas

- Se uma linha falha de forma persistente, ela continua pendente e **bloqueia os eventos posteriores da mesma wallet**, porque o `NOT EXISTS` não considera `next_attempt_at`. A ordem é preservada à custa de liveness por wallet. Ver [limitações](#trade-offs-e-limitações).
- Publicação duplicada é possível, por design (at-least-once). Ver próxima seção.

### Cenário de recuperação (seção 11 do desafio)

| Passo | O que acontece | Garantia |
|---|---|---|
| 1. PostgreSQL confirma o commit | Transação, saldo, ledger, inbox e outbox comitam juntos. Os eventos ficam com `published_at IS NULL` | Evento existe se e somente se o efeito existe |
| 2. Processo morre antes de publicar | A conexão cai. O PostgreSQL libera os locks de linha e faz rollback do lote em andamento | Nenhum `published_at` parcial é registrado |
| 3. Outra instância assume | No próximo poll, `FOR UPDATE SKIP LOCKED` pega as linhas, que agora estão livres | Atraso de, no máximo, `OUTBOX_POLL_MS` (mais o backoff, se houve falha anterior) |
| 4. Evento publicado | `SendMessage` com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`. `published_at` é gravado no commit do lote | Ordem por wallet |
| 5. Publicação duplicada | Se o processo morreu depois do `SendMessage` e antes do commit, o evento é republicado. O FIFO descarta duplicatas com o mesmo `MessageDeduplicationId` dentro da janela de 5 min. Depois dela, o consumidor deve deduplicar por `eventId` | Seguro para o consumidor: `eventId` é estável |

**Nota sobre o passo 5:** neste repositório não há consumidor de `wager-events.fifo`. O contrato para os consumidores downstream é deduplicar por `eventId`, e isso está documentado aqui e no envelope do evento.

---

## Observabilidade

### Logs

- JSON via **pino**, com `service` e `instance` (`INSTANCE_ID`) em todas as linhas.
- `correlationId` propagado por **AsyncLocalStorage**. O header `x-correlation-id` é reutilizado se for válido (até 128 caracteres de `A-Za-z0-9._:-`); caso contrário, um UUID v7 é gerado. Em mensagens SQS, o `correlationId` do `data` ou o `messageId` é usado.
- Campos de contexto usados: `messageId`, `correlationId`, `transactionId`, `walletId`, `providerId`, `component`, `failureCode`, `status`.
- **Redação**: as chaves `money`, `payload`, `balance`, `body` e `authorization` são removidas dos logs, no nível raiz e um nível abaixo (`*.money`, etc.).
- **Erros de banco** são logados apenas com a classe e o SQLSTATE. A mensagem original do driver é omitida porque contém parâmetros.
- Erros de cliente (4xx) não são logados como erro. Falhas transitórias são logadas como aviso.

### Métricas (`GET /metrics`, formato Prometheus)

| Métrica | Tipo | Labels | Significado |
|---|---|---|---|
| `wagering_transactions_total` | counter | `status`, `kind` | Transações por estado final. Reagendamentos do worker não contam |
| `wagering_duplicates_detected_total` | counter | `source` (`http`, `sqs`) | Replays de HTTP e duplicatas de SQS |
| `wagering_retries_total` | counter | `component` (`sqs`, `outbox`, `pending_reference`, `lock`) | Retries por componente |
| `wagering_dlq_messages_total` | counter | `reason` | Mensagens enviadas à DLQ |
| `wagering_lock_conflicts_total` | counter | - | Esperas por lock de wallet acima de 50 ms e `lock_timeout` |
| `wagering_outbox_lag_seconds` | gauge | - | Idade da linha pendente mais antiga da outbox |
| `wagering_processing_latency_seconds` | histogram | `source` (`http`, `sqs`, `worker`) | Latência do caso de uso |
| `wagering_reconciliation_divergences_total` | counter | - | Divergências encontradas pela reconciliação |
| métricas padrão do `prom-client` | - | - | Processo e runtime |

As métricas são por instância. Um Prometheus com scrape nas três instâncias as agrega; o serviço não as soma.

### Health

| Endpoint | Verifica | Resposta |
|---|---|---|
| `GET /health/live` | Processo respondendo | `200 {"status":"ok"}` |
| `GET /health/ready` | `SELECT 1` no PostgreSQL e `GetQueueUrl` na fila principal, cada um com timeout de 2 s | `200` se ambos respondem; `503` com `checks` indicando o que caiu |

O `GetQueueUrl` do readiness não usa o cache do resolvedor de URLs, para que uma queda seja vista na checagem seguinte. Os dois endpoints são públicos.

---

## Autenticação

### Decisão

**A autenticação não foi implementada.** O desafio permite essa escolha (seção 2), desde que ela seja documentada e o ponto de extensão fique explícito. A prioridade foi correção financeira, concorrência e idempotência, que pesam na avaliação.

### Pontos de extensão já existentes

- **`ProviderIdentityPort`** (token `PROVIDER_IDENTITY`): `resolve(authorizationHeader)` devolve o `providerId` autenticado ou `undefined`. A implementação atual é `NoopProviderIdentity`, que sempre devolve `undefined`.
- **`ProviderAuthGuard`** (registrado como `APP_GUARD`, global):
  - rotas `@Public()` (health e `/metrics`) passam sem verificação;
  - se `resolve` devolver `undefined`, a requisição segue (estado atual);
  - se devolver um `providerId`, e o corpo ou a rota tiver outro `providerId`, a resposta é `403 PROVIDER_MISMATCH`.

Trocar a implementação do port não exige mudança em nenhum outro lugar.

### Desenho proposto (Keycloak)

| Aspecto | Proposta |
|---|---|
| IdP | Keycloak no `docker-compose.yml`, com realm importado de um arquivo versionado |
| Clientes | Um cliente OIDC por provedor, com `client_credentials` (service account) e segredo rotacionável |
| Mapeamento | Atributo `providerId` no cliente, exposto como claim pelo protocol mapper. Alternativa: mapear `azp` (authorized party) |
| Validação | `resolve()` valida o JWT pela assinatura (JWKS do realm, em cache), `iss`, `aud`, `exp` e escopo `wagering:transactions:write` |
| Papéis administrativos | Criação de wallet e reconciliação exigem papel `ops`, separado dos provedores |
| Públicos | `/health/*` e `/metrics` continuam com `@Public()` |
| Fila SQS | Canal interno confiável, conforme a seção 2. O `providerId` da mensagem continua sujeito às validações de domínio (`WALLET_PLAYER_MISMATCH`, etc.) |

Zitadel é alternativa equivalente, mais leve e API-first.

---

## Testes

### Estratégia

| Nível | Escopo | Dependências | Localização |
|---|---|---|---|
| Unitário | Domínio (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, eventos, hash), classificação do consumidor, validação HTTP, mapeamento de exceções, observabilidade, `OutboxMessage` | Nenhuma | `test/unit/` |
| Integração | Migrations e constraints, atomicidade entre wallet, ledger, inbox e outbox, inbox e redelivery, publishers concorrentes, retry e DLQ, recuperação após reinício, concorrência HTTP, múltiplas instâncias | PostgreSQL e LocalStack reais | `test/integration/` |
| Carga | Throughput, latência (p50, p95, p99), taxa de erro, conflitos de lock, lag da outbox | Infraestrutura completa | `scripts/load-test.ts` |

Não há mocks de banco nem de fila em nenhum teste de integração. Os helpers em `test/support/` usam os clientes reais do PostgreSQL (MikroORM) e do SQS (AWS SDK).

### Cenários exigidos pela seção 13 do desafio

Os cenários de concorrência são executados contra o serviço real, com requisições simultâneas. Os de falha usam o mesmo caminho de produção, sem atalhos. Os tópicos cobertos pela suíte de integração são:

- a mesma aposta enviada em paralelo várias vezes resulta em um único débito;
- operações concorrentes na mesma wallet (cenário da seção 8: saldo de 100, duas apostas de 80, uma processada e outra rejeitada, saldo final de 20, um único débito);
- wallets distintas processadas em paralelo;
- três ou mais instâncias simultâneas;
- morte do worker depois do commit e antes do ack (`FAULT_CRASH_AFTER_COMMIT`), com redelivery tratado pela inbox;
- dois publishers sobre a mesma outbox, sem duplicar nem perder eventos além do at-least-once esperado;
- `ROLLBACK` ou `REFUND` entregue antes da referência, resolvido pelo worker;
- reinício do serviço com consistência final verificada.

**Invariante final de todos os testes:** `wallet.balance == saldo reconstruído pelo ledger`. É a mesma verificação que o endpoint de reconciliação faz.

Mapa arquivo → o que prova (resultado da última execução: 47 testes, 0 falhas, ~105 s):

| Arquivo | Prova |
|---|---|
| `01-migrations-constraints` | Garantias no schema via SQL direto (CHECKs, uniques, triggers append-only, reversão única) e migrations up → down → up em banco descartável |
| `02-atomicity` | Wallet, transação, ledger e outbox confirmados juntos; falha no meio da transação (erro de aplicação e violação de CHECK) não persiste nada |
| `03-inbox-redelivery` | Mesmo `messageId` 3x → um efeito; `messageId`s diferentes com mesma key → um efeito; HTTP e SQS compartilham a idempotência |
| `04-outbox-publishers` | Dois publishers concorrentes → cada evento publicado uma vez; falha injetada → retry sem bloquear outras wallets |
| `05-retry-dlq` | Erros permanentes → DLQ com `reason`; banco cortado por proxy TCP → retries e DLQ (`MAX_RECEIVES_EXCEEDED`); banco volta antes do limite → aplicado uma vez; rejeição de negócio → ack |
| `06-restart-recovery` | `kill -9` após commit sem publisher vivo → reinício publica a outbox; mensagens enfileiradas com a frota parada → aplicadas uma vez |
| `07-concurrency-http` | C1 (50 apostas idênticas → 1 débito), C2 (cenário da seção 8 + retries + 25 repetições), hot wallet, C3 (20 wallets em paralelo) |
| `08-multi-instance` | C4: 3 processos, 150 apostas HTTP + 150 SQS na mesma wallet → exatamente 50 processadas, saldo 0.00; C6: dois processos publishers |
| `09-crash-after-commit` | C5: `FAULT_CRASH_AFTER_COMMIT=1` → processo sai com 137 após commit; redelivery deduplicado pela inbox; mensagem removida no final |
| `10-reference-ordering` | C7: ROLLBACK/REFUND antes da referência (202 → processado pelo worker), referência que nunca chega → `REFERENCE_NOT_FOUND`, corrida ROLLBACK × BET |
| `11-restart-consistency` | C8: 3 processos, 240 operações, um morto com `kill -9` no meio e reiniciado → saldos batem com o esperado, DLQ vazia, 492 eventos publicados uma vez e em ordem |
| `12-sigterm` | SIGTERM durante consumo → shutdown limpo e outra instância conclui sem perda nem duplicação |

O helper `assertWalletConsistent` vai além do invariante pedido: também verifica saldo nunca negativo, cadeia `balance_before → balance_after` contínua no ledger e no máximo um lançamento por transação.

Observação: no SIGTERM, o `enableShutdownHooks` do Nest fecha a aplicação e re-emite o sinal, então o processo termina com status 143 (SIGTERM) depois do shutdown gracioso — comportamento padrão de processos em container.

### Comandos

```bash
bun run test:unit
bun run infra:up
bun run test:integration
bun run test:load
bun run test            # unitários + integração
```

---

## Trade-offs e limitações

### Decisões assumidas

| Decisão | Ganho | Custo |
|---|---|---|
| Lock pessimista por wallet | Correção sem retry storm em wallets quentes | Vazão de uma wallet é serial |
| SQL explícito no caminho financeiro | Controle exato de locks, `RETURNING` e índices parciais | Mapeamento escrito à mão; mudança de schema exige editar SQL |
| Repositórios sem portas | Menos cerimônia; SQL visível | Aplicação depende de classes concretas e do MikroORM |
| Rejeições persistidas | Auditoria e replay consistente | Tabela cresce com rejeições |
| Outbox na mesma transação | Evento existe se e somente se o efeito existe | Latência de publicação de até `OUTBOX_POLL_MS` |
| Publicação dentro da transação do lote | Ordem por wallet preservada com N publishers | Locks de linha ficam presos durante as chamadas ao SQS |
| `IdempotencyConflictError` com ack | DLQ contém só o que um reprocessamento pode resolver | Conflito fica só no log |
| Janela fixa de referências pendentes (cerca de 3 min) | Limite previsível para transações penduradas | Referência atrasada além da janela é rejeitada e exige novo id |

### Limitações conhecidas

1. **Sem autenticação real.** Pontos de extensão prontos; ver [autenticação](#autenticação).
2. **Ledger de partida simples**, não de partidas dobradas. Cada lançamento registra o efeito na wallet, sem contrapartida em conta de sistema. Ver a seção de [próximos passos](#o-que-eu-faria-com-mais-tempo).
3. **Sem reversão parcial.** `REFUND` e `ROLLBACK` são sempre integrais, conforme o desafio.
4. **Lock pessimista limita a vazão por wallet.** Correto por design, mas uma wallet com carga muito alta fica limitada pela latência de uma transação curta.
5. **Linha "veneno" na outbox** bloqueia os eventos posteriores da mesma wallet até que ela publique com sucesso. Não há limite de tentativas nem quarentena. A métrica `wagering_outbox_lag_seconds` e os logs de falha são o sinal para intervenção.
6. **Invariante global saldo x ledger não é imposta por constraint.** É garantida pelo código sob lock, e verificada pela reconciliação e pelos testes. Um `CHECK` por linha não consegue expressá-la.
7. **Estado `FAILED` não é produzido por nenhum fluxo.** Está modelado (domínio, constraint, mapeamento HTTP) para um caminho de erro permanente que ainda não foi implementado.
8. **Uma transação rejeitada consome `externalTransactionId` e chave.** Corrigir o payload exige novo id, responsabilidade do provedor. A regra está documentada (regra 21).
9. **Repositórios e ORM na camada de aplicação.** `WageringService` e `WalletService` conhecem `MikroORM` e os repositórios concretos. A fronteira domínio x aplicação é respeitada; a de aplicação x infraestrutura não é totalmente.
10. **LocalStack não reproduz integralmente o SQS FIFO.** Em especial, o bloqueio de grupo após `ChangeMessageVisibility`. A correção não depende disso.
11. **Uma moeda testada de ponta a ponta** (`BRL`). O modelo é multimoeda, e os conflitos de moeda têm teste unitário.
12. **Reconciliação sob demanda.** Não há job agendado nem alerta automático para divergências.
13. **Idempotência sem expiração.** As chaves são guardadas indefinidamente, o que é correto para auditoria, mas cresce sem limite.
14. **Métricas por instância.** Agregação depende do Prometheus.
15. **Um único banco.** Não há particionamento nem sharding. O ledger cresce sem limite de arquivamento.
16. **Limite de 100 KB no corpo** (padrão do Express), sem configuração específica.
17. **Timeout global de 10 s** (`statement_timeout`) pode interromper consultas legítimas de reconciliação em wallets com muitos lançamentos.
18. **Vazão da outbox por wallet.** Para preservar a ordem com N publishers, cada ciclo elege só a linha pendente mais antiga de cada wallet: uma wallet publica no máximo um evento por lote. No teste de carga (2 vCPU) a publicação ficou em ~100 eventos/s e foi o estágio mais lento (backlog drenado em ~40 s após o fim do tráfego). Alternativa: travar por agregado (advisory lock por `aggregate_id`) e publicar a sequência inteira da wallet no mesmo lote. Ver [`docs/load-test-results.md`](docs/load-test-results.md).

---

## O que eu faria com mais tempo

Em ordem aproximada de valor:

1. **Ledger de partidas dobradas.** Cada movimentação gera duas entradas (wallet e conta de sistema por moeda e provedor). O saldo da wallet passa a ser projeção, e a soma das contrapartidas precisa ser zero por transação, imposto por constraint deferível.
2. **Invariante saldo x ledger no banco.** Constraint `DEFERRABLE INITIALLY DEFERRED` com trigger que verifica `balance = soma do ledger` no commit da transação.
3. **Reversão parcial.** Acompanhar o saldo reversível de cada `BET` (`reversible_amount`), permitindo vários reembolsos até o limite do valor original.
4. **Quarentena na outbox.** Após N tentativas, mover a linha para uma tabela de quarentena com alerta, e definir uma política explícita para a ordem da wallet enquanto a linha está em quarentena.
5. **Keycloak** conforme o desenho proposto, com papéis administrativos.
6. **OpenTelemetry.** Traces de HTTP até o banco e do SQS até o consumidor, com o `correlationId` propagado como atributo de mensagem.
7. **Reconciliação agendada** com alerta, e um endpoint de listagem das divergências.
8. **Ferramenta de reprocessamento de DLQ** com persistência das mensagens e comando de replay.
9. **Particionamento do ledger** por tempo ou por hash da wallet, com política de arquivamento.
10. **SNS como fan-out** de `wager-events`, com uma fila por consumidor, em vez de uma única fila de saída.
11. **Política de retenção das chaves de idempotência**, com expurgo após o período de auditoria.
12. **Read model** para consultas de ledger em wallets muito grandes, separado da escrita.
