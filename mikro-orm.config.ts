import { defineConfig, MikroORM, PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { Env } from './src/infrastructure/config/env';
import { InboxSchema } from './src/infrastructure/persistence/schemas/inbox.schema';
import { LedgerEntrySchema } from './src/infrastructure/persistence/schemas/ledger-entry.schema';
import { OutboxSchema } from './src/infrastructure/persistence/schemas/outbox.schema';
import { WagerTransactionSchema } from './src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletSchema } from './src/infrastructure/persistence/schemas/wallet.schema';

const MIGRATIONS_PATH = './src/infrastructure/persistence/migrations';

export function createOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: env.DATABASE_URL,
    baseDir: import.meta.dir,
    entities: [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema],
    allowGlobalContext: false,
    pool: { max: env.DB_POOL_MAX },
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      // The schema is hand-written (constraints, partial indexes, triggers); no snapshot diffing.
      snapshot: false,
    },
  });
}

export function createOrm(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig(env));
}
