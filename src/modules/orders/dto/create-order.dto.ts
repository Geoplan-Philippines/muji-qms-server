import { IsString, IsUUID, MinLength } from 'class-validator';

export class CreateOrderDTO {
  @IsString()
  @MinLength(4)
  orderNumber!: string;

  @IsUUID()
  storeId!: string;
}
