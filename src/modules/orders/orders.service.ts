import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../core/database/prisma.service';
import { OrdersGateway } from './orders.gateway';
import { CreateOrderDTO } from './dto/create-order.dto';
import { UpdateOrderStatusDTO } from './dto/update-order-status.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: OrdersGateway,
  ) {}

  async createOrder(dto: CreateOrderDTO) {
    await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });

    const order = await this.prisma.order.create({
      data: {
        orderNumber: dto.orderNumber,
        storeId:     dto.storeId,
        orderStatus: 'PREPARING',
      },
    });

    this.gateway.emitOrderCreated(order.storeId, order);
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDTO) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    const updated = await this.prisma.order.update({
      where: { id },
      data:  { orderStatus: dto.status },
    });

    this.gateway.emitStatusUpdated(updated.storeId, updated);
    return updated;
  }

  async getOrdersByStore(storeId: string) {
    return this.prisma.order.findMany({
      where:   { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
