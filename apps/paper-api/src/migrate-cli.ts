import { createDatabase } from './db/database.js';
import { migrateToLatest } from './db/migrate.js';

/**
 * One-off migration job for releases: runs the new image's migrations against
 * DATABASE_URL while the previous release is still serving, so a migration
 * failure aborts the rollout before any downtime (deployment guide, rollout
 * step 1). Migrations are additive and backward compatible by contract.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const db = createDatabase(url);
try {
  await migrateToLatest(db);
  console.log('migrations applied');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
