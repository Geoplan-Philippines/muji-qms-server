import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../core/database/prisma.service';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async getStores() {
    return this.prisma.store.findMany({ orderBy: { name: 'asc' } });
  }

  async getStoreById(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }
}
