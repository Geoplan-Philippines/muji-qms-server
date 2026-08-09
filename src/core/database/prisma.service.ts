import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { env } from '../config/env.config';

/**
 * Postgres/pg error conditions that mean "the connection went away", as opposed
 * to "your query is wrong". Only these are worth retrying: the pool will hand
 * out a fresh connection on the next attempt.
 */
const TRANSIENT_ERROR_CODES = new Set([
  // Prisma
  'P1001', // can't reach database server
  'P1002', // database server reached but timed out
  'P1008', // operation timed out
  'P1017', // server has closed the connection
  // Postgres class 08 — connection exception
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  // Postgres class 57 — operator intervention (restart, idle-session kill)
  '57P01',
  '57P02',
  '57P03',
  // Node socket level
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const RETRY_BASE_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Errors arrive wrapped by Prisma, so look for a code anywhere down the chain. */
const collectErrorCodes = (error: unknown): string[] => {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') codes.push(candidate.code);
    current = candidate.cause;
  }
  return codes;
};

export const isTransientDbError = (error: unknown): boolean => {
  if (collectErrorCodes(error).some((code) => TRANSIENT_ERROR_CODES.has(code))) {
    return true;
  }
  // Prisma sometimes surfaces a pool/socket failure with no usable code.
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('connection terminated') ||
    message.includes('connection closed') ||
    message.includes('server has closed the connection') ||
    message.includes('timeout exceeded when trying to connect')
  );
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly log = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor() {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      // Recycle idle connections well inside the window in which a Windows
      // firewall or router silently drops an idle TCP session, so the pool never
      // hands out a socket that is already dead.
      idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
      // Without this pg waits forever for a free connection. A database that is
      // down then produces requests that hang instead of failing — which is what
      // leaves screens spinning and needs a service restart to clear.
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // A query that never returns would otherwise pin a pool slot for good.
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
      query_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    });

    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;

    /**
     * Not optional. node-postgres emits 'error' on the pool when an *idle*
     * client dies — a database restart, an idle-session reaper, a NAT timeout.
     * With no listener attached Node treats it as an unhandled 'error' event and
     * terminates the process: every socket in the shop drops and every REST call
     * fails at once, recoverable only by starting the backend again. Handling it
     * lets pg discard the dead client and carry on.
     */
    pool.on('error', (error) => {
      PrismaService.log.error(
        `Idle client error (pool recovers automatically): ${error.message}`,
      );
    });

    pool.on('connect', () => {
      PrismaService.log.debug(
        `pg connect (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`,
      );
    });
  }

  async onModuleInit() {
    // Never let a database that is merely slow to boot take the API down with
    // it: the mini PC starts Postgres and this service at the same time, and the
    // health endpoint plus the retry path can report the truth in the meantime.
    try {
      await this.$connect();
      PrismaService.log.log('Database connected');
    } catch (error) {
      PrismaService.log.error(
        `Initial database connection failed, continuing and retrying on demand: ${
          (error as Error).message
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs a read through a bounded retry so a dropped connection surfaces as a
   * short delay instead of a 5xx. Reads only — retrying a write could duplicate
   * it, and the create path is already protected by a unique index.
   */
  async readWithRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= env.DB_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransientDbError(error) || attempt === env.DB_RETRY_ATTEMPTS) break;

        const delay = RETRY_BASE_DELAY_MS * attempt;
        PrismaService.log.warn(
          `${label}: transient database error on attempt ${attempt}/${env.DB_RETRY_ATTEMPTS}, ` +
            `retrying in ${delay}ms — ${(error as Error).message}`,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  /** Cheap liveness probe used by GET /api/v1/health. */
  async isDatabaseReachable(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      PrismaService.log.warn(`Health probe failed: ${(error as Error).message}`);
      return false;
    }
  }

  poolStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: env.DB_POOL_MAX,
    };
  }
}
