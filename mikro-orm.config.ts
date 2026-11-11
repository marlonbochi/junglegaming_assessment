import { defineConfig, MikroORM, PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { Env } from './src/infrastructure/config/env';

const MIGRATIONS_PATH = './src/infrastructure/persistence/migrations';

export function createOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: env.DATABASE_URL,
    baseDir: import.meta.dir,
    entities: [],
    // Entity schemas are registered by the persistence layer; the migrator must work without them.
    discovery: { warnWhenNoEntities: false },
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
