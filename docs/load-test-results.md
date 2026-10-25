# Resultados do teste de carga

Gerado por `bun run test:load` (`scripts/load-test.ts`) contra três instâncias locais do serviço.
O script não inicia nada por conta própria; ele apenas dispara tráfego contra `LOAD_TARGETS` e depois audita o Postgres.

## Ambiente

| Item | Valor |
|---|---|
| CPU | `nproc` = 2 (Intel Xeon @ 2.10 GHz, Firecracker VM, Linux 6.18) |
| RAM | 8 GiB no total (cerca de 6 GiB livres durante as execuções) |
| Runtime | Bun 1.4.4, NestJS 10, MikroORM 6 |
| Banco de dados | PostgreSQL 16.15 (docker `postgres:16-alpine`, configuração padrão, `max_connections=100`) |
| Broker | LocalStack 3.8 SQS (docker), filas FIFO de `infra/localstack-init.sh` |
| Topologia da aplicação | 3 processos, `PORT=3001..3003 bun src/main.ts`, cada um com HTTP + consumidor SQS + publicador de outbox + worker de referências pendentes, pool padrão de 20 conexões |
| Tudo compartilha as 2 vCPUs | 3 processos da aplicação, o gerador de carga, Postgres e LocalStack rodaram na mesma máquina |

Executado como `LOAD_WALLETS=50 LOAD_DURATION_S=20 LOAD_CONCURRENCY=64 bun scripts/load-test.ts` (padrões) e uma segunda variante sem contenção, com `LOAD_HOT_PERCENT=0 LOAD_WALLETS=100`.
As instâncias foram iniciadas com `BUN_OPTIONS` não definido (este sandbox exporta `--smol`, que faz o Bun trocar velocidade por memória).

## Cenário A: 50 carteiras, 20% de todo o tráfego em uma única carteira "quente"

| Parâmetro | Valor |
|---|---|
| Alvos | http://localhost:3001, http://localhost:3002, http://localhost:3003 |
| Carteiras (K) | 50 (20% do tráfego na carteira #0) |
| Duração (D) | 20s (medido 20.8s) |
| Concorrência (C) | 64 |
| Host | 2 CPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 7.8 GiB de RAM (6.2 GiB livres ao final) |
| Runtime | Bun 1.4.4 |

| Métrica | Resultado |
|---|---|
| Requisições concluídas | 2230 |
| Vazão | 107 req/s |
| Latência p50 / p95 / p99 / máx | 194.8 / 2806.5 / 6644.1 / 10640.4 ms |
| Status HTTP | 200: 107, 201: 2118, 503: 5 |
| Taxa de erro (5xx + rede) | 0.22% (0 erros de rede) |
| Mix de operações | BET: 1175, LOSS: 221, REFUND: 322, REPLAY: 107, WIN: 405 |
| Resultados de negócio | HTTP_503: 5, PROCESSED: 2118 |
| Replays idempotentes | 107/107 confirmados (idempotentReplay=true, mesmo transactionId) |
| Transações no banco (esta execução) | 2118 no total, 2118 processadas, 0 rejeitadas, 0 pendentes |
| Outbox | 4115 eventos para estas carteiras; ao fim do tráfego 3615 pendentes, mais antigo 19.52s; totalmente esvaziado 42.0s após o término do tráfego; a carteira quente tinha 774 pendentes, esvaziados após 42.0s |
| Conexões abertas no Postgres | 16 |

| Reconciliação | Resultado |
|---|---|
| POST /reconciliation carteiras inconsistentes | 0 / 50 |
| SQL: saldo armazenado != créditos - débitos | 0 / 50 |
| SQL: saldos negativos | 0 |
| SQL: entradas de razão duplicadas por transação | 0 |
| Saldo armazenado != saldo previsto a partir dos resultados observados | 0 / 50 |
| **Veredito** | **APROVADO: todos os invariantes se mantêm** |

## Cenário B: 100 carteiras, tráfego uniforme (sem carteira quente)

| Parâmetro | Valor |
|---|---|
| Alvos | http://localhost:3001, http://localhost:3002, http://localhost:3003 |
| Carteiras (K) | 100 (0% do tráfego na carteira #0) |
| Duração (D) | 20s (medido 20.2s) |
| Concorrência (C) | 64 |
| Host | 2 CPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 7.8 GiB de RAM (6.2 GiB livres ao final) |
| Runtime | Bun 1.4.4 |

| Métrica | Resultado |
|---|---|
| Requisições concluídas | 2461 |
| Vazão | 122 req/s |
| Latência p50 / p95 / p99 / máx | 480.2 / 1073.8 / 1400.8 / 1822.3 ms |
| Status HTTP | 200: 114, 201: 2347 |
| Taxa de erro (5xx + rede) | 0.00% (0 erros de rede) |
| Mix de operações | BET: 1299, LOSS: 258, REFUND: 322, REPLAY: 114, WIN: 468 |
| Resultados de negócio | PROCESSED: 2347 |
| Replays idempotentes | 114/114 confirmados (idempotentReplay=true, mesmo transactionId) |
| Transações no banco (esta execução) | 2347 no total, 2347 processadas, 0 rejeitadas, 0 pendentes |
| Outbox | 4636 eventos para estas carteiras; ao fim do tráfego 4127 pendentes, mais antigo 19.54s; totalmente esvaziado 40.3s após o término do tráfego; a carteira quente tinha 42 pendentes, esvaziados após 36.8s |
| Conexões abertas no Postgres | 16 |

| Reconciliação | Resultado |
|---|---|
| POST /reconciliation carteiras inconsistentes | 0 / 100 |
| SQL: saldo armazenado != créditos - débitos | 0 / 100 |
| SQL: saldos negativos | 0 |
| SQL: entradas de razão duplicadas por transação | 0 |
| Saldo armazenado != saldo previsto a partir dos resultados observados | 0 / 100 |
| **Veredito** | **APROVADO: todos os invariantes se mantêm** |

## Análise

**A correção se manteve sob carga.** Em ambas as execuções, cada carteira foi reconciliada de três formas independentes: o próprio `POST /wallets/:id/reconciliation` do serviço, uma comparação em SQL entre o saldo armazenado e créditos menos débitos, e o saldo previsto a partir dos resultados que o cliente observou (assim, um efeito perdido ou duplicado apareceria como divergência). Nenhum saldo negativo, nenhuma entrada de razão duplicada, nenhuma transação deixada pendente. Todos os replays idempotentes (5% das requisições reenviadas literalmente para uma instância aleatória) retornaram `idempotentReplay: true` com o `transactionId` original.

**A vazão é modesta e limitada pela CPU nesta máquina: aproximadamente 110-120 req/s.** Com duas vCPUs compartilhadas pelo gerador de carga, três processos Bun, Postgres e LocalStack, nada aqui é uma afirmação sobre o teto do design; trate o número como um limite inferior. Evidência de que o limite é a CPU e não o locking: a execução uniforme (sem carteira quente) é apenas cerca de 14% mais rápida que a execução com carteira quente, mas sua latência é bem mais estável (p95 de 1.1 s contra 2.8 s). A latência em C=64 é majoritariamente fila: 64 clientes sobre cerca de 120 req/s resultam em aproximadamente 0.5 s por requisição, exatamente o p50 da execução uniforme.

**Uma única carteira quente custa latência de cauda, não correção.** O Cenário A envia cerca de 20% do tráfego (por volta de 20 req/s) por uma única trava de linha (`SELECT ... FOR UPDATE`). As requisições dessa carteira ficam enfileiradas umas atrás das outras, o que estica o p95 para 2.8 s e o p99 para 6.6 s. Com a CPU saturada, algumas delas aguardaram além do `statement_timeout` de 10 s e receberam `503 TRANSIENT_INFRASTRUCTURE` (5 de 2,230 requisições, 0.22%). Esse é o contrato pretendido (nada foi confirmado, `Retry-After` está definido, o provedor reenvia a mesma chave), e a auditoria acima confirma que não houve efeito parcial. O Cenário B não apresenta nenhum 5xx.

**O publicador de outbox é o estágio mais lento, com larga margem.** Os eventos são confirmados na mesma transação que a movimentação de dinheiro, mas a publicação ficou para trás: ao fim de 20 s de tráfego, entre 3,600 e 4,100 eventos ainda não estavam publicados (o mais antigo com cerca de 19.5 s, o que significa que o publicador só começou a alcançar o atraso depois que o tráfego parou), e o acúmulo levou de 40 a 42 s para ser esvaziado, cerca de 100 eventos/s somando os três publicadores. Duas causas, ambas visíveis no código:

1. cada evento é um `SendMessage` sequencial para o LocalStack dentro da transação do lote;
2. `SELECT_DUE_SQL` só torna elegível a linha pendente mais antiga de cada agregado, então um lote publica no máximo um evento por carteira. Isso protege a ordem por carteira com vários publicadores, mas limita a taxa de publicação de uma carteira a um evento por ciclo de lote.
   O Cenário A demonstra isso: a carteira quente tinha 774 eventos pendentes e precisou dos 42 s completos (cerca de 18 eventos/s), enquanto as carteiras frias já haviam terminado.

   Trata-se de um limite de vazão, não de um problema de correção: nenhum evento foi perdido, duplicado ou reordenado, e `outbox_lag_seconds` expõe o problema.
   Se isso importar, a correção é permitir que um lote pegue várias linhas consecutivas do mesmo agregado (uma janela `row_number() OVER (PARTITION BY aggregate_id)`, publicada em ordem dentro da mesma transação) e usar `SendMessageBatch` para a fila de eventos. Não alterei `src/` para isso.

**O que isto não demonstra.** Uma máquina, um Postgres, LocalStack no lugar do SQS real, execuções de 20 s, nenhuma injeção de falhas durante a execução (a suíte de integração cobre kill -9, SIGTERM e perda do banco de dados). A vazão real em núcleos dedicados e com um Postgres ajustado deveria ser várias vezes maior; o teto da carteira quente (uma trava de linha, serializada) e o limite de publicação por agregado continuariam sendo os primeiros limites a serem atingidos.
