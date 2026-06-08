import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { OrdersService } from './orders.service';
import { CreateOrderDTO } from './dto/create-order.dto';
import { UpdateOrderStatusDTO } from './dto/update-order-status.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

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
}
