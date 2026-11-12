import { defineConfig, MikroORM, PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { Env } from './src/infrastructure/config/env';
import { InboxSchema } from './src/infrastructure/persistence/schemas/inbox.schema';
import { LedgerEntrySchema } from './src/infrastructure/persistence/schemas/ledger-entry.schema';
import { OutboxSchema } from './src/infrastructure/persistence/schemas/outbox.schema';
import { WagerTransactionSchema } from './src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletSchema } from './src/infrastructure/persistence/schemas/wallet.schema';

const MIGRATIONS_PATH = './src/infrastructure/persistence/migrations';
/** `statement_timeout` only applies once connected; this bounds the connect itself (unreachable or silent host). */
const CONNECT_TIMEOUT_MS = 5000;

export function createOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: env.DATABASE_URL,
    baseDir: import.meta.dir,
    entities: [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema],
    allowGlobalContext: false,
    pool: { max: env.DB_POOL_MAX },
    // Handed to the `pg` Pool as is; MikroORM's `pool` option only maps min/max/idleTimeoutMillis.
    driverOptions: { connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
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
