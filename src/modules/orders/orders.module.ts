import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersGateway } from './orders.gateway';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports:     [StoresModule],
  controllers: [OrdersController],
  providers:   [OrdersService, OrdersGateway],
})
export class OrdersModule {}
