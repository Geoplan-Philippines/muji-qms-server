import { IsEnum } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderStatusDTO {
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
