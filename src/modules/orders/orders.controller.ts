import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { OrdersService } from './orders.service';
import { OrdersGateway } from './orders.gateway';
import { CreateOrderDTO } from './dto/create-order.dto';
import { UpdateOrderStatusDTO } from './dto/update-order-status.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly ordersGateway: OrdersGateway,
  ) {}

  @Post()
  createOrder(@Body() dto: CreateOrderDTO) {
    return this.ordersService.createOrder(dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDTO,
  ) {
    return this.ordersService.updateStatus(id, dto);
  }

  @Get('store/:storeId')
  getOrdersByStore(@Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.ordersService.getOrdersByStore(storeId);
  }

  /**
   * Live answer to "is that quiet display still in its store room?".
   *
   * Read-only, unauthenticated and un-throttled on purpose: it is the first
   * thing to check during an incident on the shop floor, and requiring a token
   * would make it useless at exactly that moment. It exposes socket ids, LAN
   * addresses and room membership — nothing that isn't already visible to
   * anything on the same network.
   */
  @Get('diagnostics/sockets')
  @SkipThrottle()
  socketDiagnostics() {
    return this.ordersGateway.roomDiagnostics();
  }
}
