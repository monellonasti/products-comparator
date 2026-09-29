// CLI: pnpm user:create -- --email a@b.it --name "Mario Rossi" --role admin
// The password is read from the COMPARATOR_PASSWORD env var or prompted on stdin (never passed as an argument).
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { migrate } from '../db/migrate.ts';
import { pool } from '../db/pool.ts';
import { config } from '../config.ts';
import { hashPassword, validatePasswordPolicy } from '../server/auth.ts';

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'operator' } } });
if (!values.email || !values.name || !['admin', 'operator'].includes(values.role!)) {
  console.error('Uso: pnpm user:create -- --email <email> --name "<nome>" --role admin|operator');
  process.exit(1);
}
let password = process.env.COMPARATOR_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 12 caratteri): ');
  rl.close();
}
const policy = validatePasswordPolicy(password);
if (policy) {
  console.error(policy);
  process.exit(1);
}
await migrate(config.DATABASE_URL, () => {});
const res = await pool.query(
  `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
   ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, active = true, updated_at = now()
   RETURNING id, email, role`,
  [values.email, values.name, values.role, await hashPassword(password)],
);
// Existing account: a new password (or role) must not leave sessions opened with the old one.
const ended = await pool.query('DELETE FROM sessions WHERE user_id = $1', [res.rows[0].id]);
console.log(`utente pronto: ${res.rows[0].email} (${res.rows[0].role})${ended.rowCount ? `, ${ended.rowCount} sessioni chiuse` : ''}`);
await pool.end();
