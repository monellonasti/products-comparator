// CLI: pnpm migrate
import { migrate } from '../db/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
try {
  const applied = await migrate(url);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database up to date');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
