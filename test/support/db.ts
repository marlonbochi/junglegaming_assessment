import { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { createOrmConfig } from '../../mikro-orm.config';
import { sqlClient } from './sql';

const SERVER_URL = process.env.TEST_DATABASE_SERVER_URL ?? 'postgres://postgres:postgres@localhost:55432';

export const TEMPLATE_DATABASE = 'wagering_template';

export function databaseUrl(name: string): string {
  return `${SERVER_URL}/${name}`;
}

/** Client on the `postgres` maintenance database, for CREATE/DROP DATABASE. */
export function adminClient(): SQL {
  return sqlClient(databaseUrl('postgres'));
}

export interface TestDatabase {
  url: string;
  sql: SQL;
  drop(): Promise<void>;
}

/** Creates an isolated database cloned from the migrated template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = adminClient();
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`);
  } finally {
    await admin.close();
  }
  const url = databaseUrl(name);
  const sql = sqlClient(url);
  return {
    url,
    sql,
    async drop() {
      await sql.close();
      const dropper = adminClient();
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}

/** Runs every migration up, or reverts every executed migration, against `url`. */
export async function migrateDatabase(url: string, direction: 'up' | 'down'): Promise<void> {
  const config = createOrmConfig({ DATABASE_URL: url, DB_POOL_MAX: 2 });
  const orm = await MikroORM.init({ ...config, migrations: { ...config.migrations, silent: true } });
  try {
    if (direction === 'up') await orm.migrator.up();
    else await orm.migrator.down({ to: 0 });
  } finally {
    await orm.close(true);
  }
}
