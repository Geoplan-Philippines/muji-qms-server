import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Order } from '@prisma/client';

@WebSocketGateway({ cors: { origin: '*' }, namespace: 'orders' })
export class OrdersGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  afterInit() {}

  handleConnection(client: Socket) {
    console.log(`[OrdersGateway] Client connected: ${client.id}`);
    // Send the server's clock immediately so displays can calibrate on load,
    // even when the queue is empty. The time source is this LAN machine's own
    // clock — no internet/NTP required.
    client.emit('time:sync', { now: Date.now() });
  }

  handleDisconnect(client: Socket) {
    console.log(`[OrdersGateway] Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-store')
  handleJoinStore(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { storeId: string },
  ) {
    client.join(`store:${data.storeId}`);
  }

  @SubscribeMessage('time:request')
  handleTimeRequest(@ConnectedSocket() client: Socket) {
    // Lets a display periodically re-sync to correct for device clock drift.
    client.emit('time:sync', { now: Date.now() });
  }

  @SubscribeMessage('chime:replay')
  handleChimeReplay(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { storeId: string },
  ) {
    if (!data?.storeId) return;

    const room = `store:${data.storeId}`;
    if (!client.rooms.has(room)) return;

    this.server.to(room).emit('chime:play');
  }

  emitOrderCreated(storeId: string, order: Order) {
    this.server.to(`store:${storeId}`).emit('order:created', order);
  }

  emitStatusUpdated(storeId: string, order: Order) {
    this.server.to(`store:${storeId}`).emit('order:status-updated', order);
  }
}
