import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().startsWith('postgresql://').min(1),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:4200')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  // The devices reach this box by its LAN address, which DHCP can change. An
  // allowlist of literal origins fails closed when that happens and every screen
  // in the shop blanks at once, so private-network origins are accepted by
  // default. Set to false if the box is ever exposed beyond the shop LAN.
  CORS_ALLOW_LAN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  JWT_SECRET: z.string().min(32),

  // --- Database pool -------------------------------------------------------
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10_000),
  /** Bounded so a down database fails fast instead of hanging every request. */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** Stops a stuck query from holding a pool slot forever. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof schema>;
