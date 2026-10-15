import { ConflictException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../core/database/prisma.service';
import { OrdersGateway } from './orders.gateway';

describe('OrdersService recovery', () => {
  const current = { id: 'order-id', storeId: 'store-id', orderNumber: '7126', orderStatus: OrderStatus.SERVING };
  const setup = () => {
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(current), update: jest.fn() },
    };
    const gateway = { emitStatusUpdated: jest.fn() };
    const service = new OrdersService(prisma as unknown as PrismaService, gateway as unknown as OrdersGateway);
    return { service, prisma, gateway };
  };

  it.each([OrderStatus.SERVING, OrderStatus.SERVED, OrderStatus.CANCELLED])(
    'accepts a repeated %s action without resetting timestamps', async (status) => {
      const { service, prisma, gateway } = setup();
      const saved = { ...current, orderStatus: status };
      prisma.order.findUnique.mockResolvedValue(saved);
      expect(await service.updateStatus(current.id, { status })).toBe(saved);
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(gateway.emitStatusUpdated).not.toHaveBeenCalled();
    },
  );

  it('refuses to put a collected order back on the board', async () => {
    const { service, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue({ ...current, orderStatus: OrderStatus.SERVED });
    await expect(service.updateStatus(current.id, { status: OrderStatus.PREPARING })).rejects.toThrow(ConflictException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects a concurrent change rather than overwriting another tablet', async () => {
    const { service, prisma, gateway } = setup();
    prisma.order.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('changed', {
      code: 'P2025', clientVersion: 'test',
    }));
    await expect(service.updateStatus(current.id, { status: OrderStatus.ON_HOLD })).rejects.toThrow(ConflictException);
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: current.id, orderStatus: OrderStatus.SERVING }, data: { orderStatus: OrderStatus.ON_HOLD },
    });
    expect(gateway.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it('keeps a committed change successful when broadcasting fails', async () => {
    const { service, prisma, gateway } = setup();
    const updated = { ...current, orderStatus: OrderStatus.SERVED };
    prisma.order.update.mockResolvedValue(updated);
    gateway.emitStatusUpdated.mockImplementation(() => { throw new Error('socket unavailable'); });
    expect(await service.updateStatus(current.id, { status: OrderStatus.SERVED })).toBe(updated);
  });
});
