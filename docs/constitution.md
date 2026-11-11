# Constitution — Distributed Wagering Processor

Regras invioláveis do projeto. Toda tarefa do plano de implementação deve ser conferida contra esta lista antes de ser considerada concluída. Em caso de conflito entre esta constitution e qualquer outro documento (spec, plano, código), **esta constitution vence** e o outro documento é corrigido.

Origem: seções 5, 6 e 14 do README do desafio + decisões aprovadas no design (`docs/superpowers/specs/2026-11-10-wagering-processor-design.md`).

## I. Dinheiro

1. Dinheiro nunca é `number`, `float` ou `double` — nem em domínio, nem em DTO, nem em persistência, nem em teste. Internamente: `bigint` em unidades mínimas; em contratos: string decimal com exatamente 2 casas; no banco: `numeric(20,2)` + `char(3)`.
2. `Money` é imutável; toda operação retorna nova instância. Operações entre moedas diferentes lançam erro de domínio.
3. Não existe arredondamento implícito: entrada fora do formato é rejeitada, nunca ajustada.

## II. Integridade financeira no banco

4. Unicidade, imutabilidade e não-negatividade são garantidas **no schema** (constraints, índices únicos, triggers), não só no código. O código é a primeira barreira; o banco é a última.
5. O ledger é append-only: nenhum lançamento é atualizado ou excluído, por código ou por SQL manual.
6. Toda alteração de saldo tem exatamente um lançamento correspondente no ledger, e vice-versa. `wallet.balance` é sempre igual ao saldo reconstruído pelo ledger.
7. Saldo nunca fica negativo, em nenhuma interleaving.

## III. Concorrência

8. A unidade de concorrência é a `walletId`. Proibido lock global compartilhado entre wallets.
9. Proibido `read → calculate → update` de saldo sem controle de concorrência. Estratégia adotada: `SELECT … FOR UPDATE` na wallet + `CHECK` no banco.
10. Toda transação trava no máximo uma wallet, sempre **wallet primeiro**, depois linhas de transação. Nenhum componente inverte essa ordem.
11. A solução é correta com N instâncias de cada serviço. Nenhuma garantia depende de estado em memória de processo.

## IV. Idempotência e mensageria

12. Idempotência é persistente (índices únicos + inbox no PostgreSQL). Cache em memória nunca é garantia.
13. Mesma idempotency key com payload diferente é **conflito**, nunca replay.
14. Recursos do SQS FIFO (ordem, dedup) são otimização, nunca garantia de consistência.
15. Inbox, transação financeira, ledger e outbox são gravados na **mesma transação SQL**.
16. Nenhum evento é publicado antes do commit. Publicação só acontece pelo outbox publisher.
17. `ack` de mensagem SQS só depois do commit.
18. Um evento confirmado nunca é descartado; publicação duplicada é aceitável e segura (consumidor deduplica por `eventId`).

## V. Modelagem

19. O domínio (`src/domain`) não importa NestJS, MikroORM, AWS SDK nem nada de infraestrutura.
20. Entidades de domínio têm construtor `private`/`protected` e factories estáticas (`create`/`open`/`from`/`rehydrate`). `rehydrate` não revalida transições.
21. Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) não transicionam; tentar é erro de programação.
22. HTTP e SQS usam o **mesmo** use case de submissão.

## VI. Testes e processo

23. TDD: nenhum código de produção sem um teste falhando antes.
24. Testes de integração, concorrência e E2E usam PostgreSQL e LocalStack **reais**. Mocks nunca substituem completamente banco ou fila.
25. Testes de concorrência usam paralelismo real (conexões/processos distintos), não chamadas sequenciais.
26. Toda suíte de integração, concorrência, E2E e carga termina verificando `wallet.balance == saldo reconstruído pelo ledger` para todas as wallets tocadas.
27. Sincronização em teste via polling com timeout (`eventually`), nunca `sleep` fixo como garantia.
28. `bun run typecheck` (`tsc --noEmit`, `strict`) passa em todo commit.

## VII. Observabilidade e segurança

29. Logs são JSON estruturado com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` quando aplicáveis, e nunca contêm payloads financeiros completos nem segredos.
30. Divergências de reconciliação nunca são corrigidas silenciosamente: são logadas, contadas em métrica e sinalizadas na resposta.
31. Endpoints de health não exigem autenticação. Autenticação, quando existir, usa IdP externo — nunca tabela própria de usuários/senhas.
