import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../core/database/prisma.service';
import { normalizeStoreId } from '../orders/store-room';

/**
 * Stores change roughly never, but `join-store` is validated against them on
 * every socket connect and reconnect. Cache the answer briefly so a reconnect
 * storm cannot turn into a burst of database reads.
 */
const STORE_EXISTS_TTL_MS = 60_000;

/**
 * A shop has a handful of stores, so this cap is never reached in normal use.
 * It exists because this process is expected to run for weeks without a restart
 * and the cache is keyed by whatever store id a client sends: without a bound,
 * anything on the LAN emitting join-store with fresh uuids would grow it
 * forever.
 */
const STORE_EXISTS_CACHE_MAX = 128;

@Injectable()
export class StoresService {
  private readonly existsCache = new Map<string, { exists: boolean; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async getStores() {
    return this.prisma.store.findMany({ orderBy: { name: 'asc' } });
  }

  async getStoreById(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  /**
   * Existence check for the socket join path. Throws if the database is
   * unreachable — the caller decides whether to fail open, and for `join-store`
   * it does.
   */
  async storeExists(storeId: string): Promise<boolean> {
    const id = normalizeStoreId(storeId);
    const cached = this.existsCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.exists;

    const store = await this.prisma.store.findUnique({
      where: { id },
      select: { id: true },
    });
    const exists = store !== null;

    // Only a positive result is worth caching for long: a store that does not
    // exist yet may be seeded at any moment, and caching "no" would keep a
    // freshly provisioned display locked out for the full TTL.
    this.evictIfFull();
    this.existsCache.set(id, {
      exists,
      expiresAt: Date.now() + (exists ? STORE_EXISTS_TTL_MS : 5_000),
    });
    return exists;
  }

  /** Drops expired entries, then the oldest, so the cache can never grow without bound. */
  private evictIfFull() {
    if (this.existsCache.size < STORE_EXISTS_CACHE_MAX) return;

    const now = Date.now();
    for (const [key, entry] of this.existsCache) {
      if (entry.expiresAt <= now) this.existsCache.delete(key);
    }

    // Still full means everything is live; a Map iterates in insertion order, so
    // this drops the least recently added.
    while (this.existsCache.size >= STORE_EXISTS_CACHE_MAX) {
      const oldest = this.existsCache.keys().next();
      if (oldest.done) break;
      this.existsCache.delete(oldest.value);
    }
  }
}
