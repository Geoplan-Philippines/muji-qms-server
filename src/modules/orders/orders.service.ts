import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../core/database/prisma.service';
import { OrdersGateway } from './orders.gateway';
import { CreateOrderDTO } from './dto/create-order.dto';
import { UpdateOrderStatusDTO } from './dto/update-order-status.dto';
import { normalizeStoreId } from './store-room';

// Statuses that occupy the board and therefore "hold" an order number.
// SERVED (collected) and CANCELLED leave the board and free the number for reuse.
const ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.PREPARING,
  OrderStatus.SERVING,
  OrderStatus.ON_HOLD,
];

// Terminal states: the order has left the board for good. No further status
// change is allowed (a cancel/serve is final), so a PATCH targeting one of
// these is a 409 conflict.
const TERMINAL_STATUSES: OrderStatus[] = [
  OrderStatus.SERVED,
  OrderStatus.CANCELLED,
];

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: OrdersGateway,
  ) {}

  async createOrder(dto: CreateOrderDTO) {
    const storeId = normalizeStoreId(dto.storeId);

    const store = await this.prisma.store.findUnique({
      where:  { id: storeId },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    const activeDuplicate = await this.prisma.order.findFirst({
      where: {
        storeId,
        orderNumber: dto.orderNumber,
        orderStatus: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
    });
    if (activeDuplicate) {
      throw new ConflictException('Order number is already active in the queue');
    }

    let order: Order;
    try {
      order = await this.prisma.order.create({
        data: {
          orderNumber: dto.orderNumber,
          storeId,
          orderStatus: OrderStatus.PREPARING,
        },
      });
    } catch (error) {
      // The check above loses to a concurrent create; the `uniq_active_order_number`
      // partial unique index is what actually guarantees it. Both paths must end
      // in 409, because the scanner retries a create whose response it never saw
      // and reads 409 as "it already landed".
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new ConflictException('Order number is already active in the queue');
      }
      throw error;
    }

    this.publish(() => this.gateway.emitOrderCreated(order.storeId, order), 'order:created');
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDTO) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    if (TERMINAL_STATUSES.includes(order.orderStatus)) {
      throw new ConflictException(
        `Order is already ${order.orderStatus.toLowerCase()} and cannot change status`,
      );
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data:  { orderStatus: dto.status },
    });

    this.publish(
      () => this.gateway.emitStatusUpdated(updated.storeId, updated),
      'order:status-updated',
    );
    return updated;
  }

  async getOrdersByStore(storeId: string) {
    // Only hydrate the board with orders that still occupy it. SERVED and
    // CANCELLED are excluded so a page reload can't resurrect them.
    //
    // Retried on a dropped connection: this is the call every display depends on,
    // and a 5xx here blanks the whole shop. A connection that died while idle
    // must cost a few hundred milliseconds, not a screen.
    return this.prisma.readWithRetry('getOrdersByStore', () =>
      this.prisma.order.findMany({
        where:   { storeId: normalizeStoreId(storeId), orderStatus: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * The write is already committed by the time we broadcast. A failure to reach
   * the socket layer must not turn a successful mutation into a 5xx — the client
   * would retry a change that already happened. Log it and let the device's
   * reconcile poll pick the state up.
   */
  private publish(emit: () => void, event: string) {
    try {
      emit();
    } catch (error) {
      this.logger.error(`Failed to broadcast ${event}: ${(error as Error).message}`);
    }
  }
}
