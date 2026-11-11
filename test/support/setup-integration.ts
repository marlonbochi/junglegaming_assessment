import { adminClient, databaseUrl, migrateDatabase, TEMPLATE_DATABASE } from './db';

/** Recreates and migrates the template database once per run; each test file clones it. */
async function recreateTemplate(): Promise<void> {
  const admin = adminClient();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  } finally {
    await admin.close();
  }
  await migrateDatabase(databaseUrl(TEMPLATE_DATABASE), 'up');
}

await recreateTemplate();
