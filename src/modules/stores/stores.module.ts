import { Module } from '@nestjs/common';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';

@Module({
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService], // OrdersGateway validates join-store against it
})
export class StoresModule {}
