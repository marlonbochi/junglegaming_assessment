import { createOrm } from '../mikro-orm.config';
import { loadEnv } from './infrastructure/config/env';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun src/main.migrate.ts up|down');
  process.exit(2);
}

const orm = await createOrm(loadEnv());
try {
  if (direction === 'up') await orm.migrator.up();
  else await orm.migrator.down();
} finally {
  await orm.close(true);
}
