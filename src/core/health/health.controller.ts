import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../database/prisma.service';
import { RawResponse } from '../../common/decorators/raw-response.decorator';

interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  uptimeSeconds: number;
  now: number;
}

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Always answers 200, even when the database is down.
   *
   * A probe that 5xxs when the dependency is unhealthy tells the caller nothing
   * it cannot read from the `db` field, and this endpoint exists precisely
   * because 5xx responses were blanking screens. `status` carries the verdict;
   * the HTTP code only says the process is alive enough to answer.
   */
  @Get()
  @RawResponse()
  async health(): Promise<HealthResponse> {
    const dbUp = await this.prisma.isDatabaseReachable();

    return {
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      uptimeSeconds: Math.round(process.uptime()),
      now: Date.now(),
    };
  }

  /**
   * Pool counters, for confirming the connection pool actually recovers after
   * the database restarts rather than sitting on dead handles. `waiting` staying
   * above zero while `idle` is zero means the pool is exhausted — the state that
   * used to require restarting the service.
   */
  @Get('details')
  @RawResponse()
  async details() {
    return {
      ...(await this.health()),
      pool: this.prisma.poolStats(),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      pid: process.pid,
    };
  }
}
