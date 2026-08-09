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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import { Namespace, Socket } from 'socket.io';
import { Order } from '@prisma/client';

import { corsOriginDelegate } from '../../core/config/cors.config';
import { StoresService } from '../stores/stores.service';
import {
  isStoreRoom,
  normalizeStoreId,
  storeIdFromRoom,
  storeRoom,
} from './store-room';

/** How often the room census is written to the log. */
const ROOM_CENSUS_INTERVAL_MS = 60_000;

type JoinStoreFailure = 'INVALID_STORE_ID' | 'UNKNOWN_STORE';

type JoinStoreAck =
  | {
      ok: true;
      storeId: string;
      room: string;
      members: number;
      alreadyJoined: boolean;
      now: number;
    }
  | { ok: false; code: JoinStoreFailure; error: string; now: number };

/** What we know about a live socket, for diagnostics. */
interface SocketRecord {
  connectedAt: number;
  address: string;
  forwardedFor?: string;
  userAgent?: string;
  /**
   * Rooms this device *asked* for. Compared against the adapter's actual
   * membership to catch a socket that silently fell out of its store room —
   * the failure that looks like a dead socket from the display's side.
   */
  intendedRooms: Set<string>;
  /**
   * Set from the `disconnecting` hook, which socket.io fires before it empties
   * the socket's rooms. Without it every clean disconnect would look like a
   * dropped room, because the socket is still listed on the namespace while
   * `leaveAll()` runs.
   */
  disconnecting: boolean;
}

/**
 * `@SkipThrottle()` is load-bearing, not cosmetic. Removing it disables every
 * message handler below.
 *
 * `ThrottlerGuard` is registered as an APP_GUARD, and Nest merges global guards
 * into websocket handlers exactly as it does into HTTP routes. The guard then
 * reads its request/response pair with `context.switchToHttp()`, but a
 * `@SubscribeMessage` handler is invoked as `(client, data, ack)` — so the guard
 * sees the socket as `req` and the *message payload* as `res`, and then calls
 * `res.header(...)` to write the rate-limit headers on every allowed request.
 *
 * A plain `{ storeId }` object has no `.header`, so the guard throws
 * `TypeError: res.header is not a function` before the handler body ever runs.
 * The socket still connects and still receives the `time:sync` sent from
 * `handleConnection` (that is a lifecycle hook, not a guarded handler), so from
 * the device the connection looks healthy — while `join-store` silently never
 * happens, the socket never enters a store room, and no order event is ever
 * delivered to it.
 *
 * Rate limiting still covers every REST route, where `req.ip` and `res.header`
 * are real.
 */
@SkipThrottle()
@WebSocketGateway({
  namespace: 'orders',
  // The client starts on polling and upgrades; both must be offered or the
  // handshake fails outright behind some Windows firewall profiles.
  transports: ['polling', 'websocket'],
  cors: {
    origin: corsOriginDelegate,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 25_000,
  pingTimeout: 20_000,
  connectTimeout: 45_000,
})
export class OrdersGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  /**
   * A namespaced gateway is handed the `Namespace`, not the root `Server` —
   * that is what exposes `.adapter` (room membership) and `.sockets`.
   */
  @WebSocketServer()
  private server!: Namespace;

  private readonly logger = new Logger(OrdersGateway.name);
  private readonly sockets = new Map<string, SocketRecord>();
  private censusTimer?: NodeJS.Timeout;

  constructor(private readonly storesService: StoresService) {}

  afterInit() {
    // Adapter-level room events catch memberships that change without us asking
    // — the case where a socket leaves its store room but stays connected.
    const { adapter } = this.server;

    adapter.on('join-room', (room: string, socketId: string) => {
      if (isStoreRoom(room)) {
        this.logger.debug(`room join   room=${room} socket=${socketId}`);
      }
    });

    adapter.on('leave-room', (room: string, socketId: string) => {
      if (!isStoreRoom(room)) return;
      const record = this.sockets.get(socketId);
      const stillWanted = record?.intendedRooms.has(room) && !record.disconnecting;
      // A leave while the socket is still connected and still wants the room is
      // the exact fault we are hunting. Log it loudly.
      if (stillWanted && this.server.sockets.has(socketId)) {
        this.logger.warn(
          `room DROPPED room=${room} socket=${socketId} — still connected and still expects this room`,
        );
      } else {
        this.logger.debug(`room leave  room=${room} socket=${socketId}`);
      }
    });

    this.censusTimer = setInterval(() => this.logRoomCensus(), ROOM_CENSUS_INTERVAL_MS);
    this.censusTimer.unref();

    this.logger.log('Orders gateway ready on namespace /orders');
  }

  onModuleDestroy() {
    if (this.censusTimer) clearInterval(this.censusTimer);
  }

  handleConnection(client: Socket) {
    const { address, headers, query } = client.handshake;
    const forwardedFor = headers['x-forwarded-for'];

    this.sockets.set(client.id, {
      connectedAt: Date.now(),
      address,
      forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor,
      userAgent: headers['user-agent'],
      intendedRooms: new Set(),
      disconnecting: false,
    });

    this.logger.log(
      `connect    socket=${client.id} ip=${address} transport=${client.conn.transport.name} ` +
        `ua="${headers['user-agent'] ?? 'unknown'}" query=${JSON.stringify(query)} ` +
        `sockets=${this.server.sockets.size}`,
    );

    client.conn.on('upgrade', () => {
      this.logger.log(
        `upgrade    socket=${client.id} transport=${client.conn.transport.name}`,
      );
    });

    // `disconnecting` fires while rooms are still populated; by the time Nest
    // calls handleDisconnect socket.io has already emptied them, so this is the
    // only place we can report which rooms the device was actually in.
    client.on('disconnecting', (reason: string, description?: unknown) => {
      const record = this.sockets.get(client.id);
      if (record) record.disconnecting = true;

      const rooms = [...client.rooms].filter(isStoreRoom);
      this.logger.log(
        `disconnect socket=${client.id} ip=${address} reason=${reason} ` +
          `transport=${client.conn.transport.name} rooms=[${rooms.join(', ')}] ` +
          `livedFor=${this.livedFor(client.id)}s` +
          (description ? ` detail=${JSON.stringify(description)}` : ''),
      );
    });

    // Displays calibrate on load, before any order exists, so send the clock
    // unprompted. The time source is this LAN machine — no internet/NTP needed.
    client.emit('time:sync', { now: Date.now() });
  }

  handleDisconnect(client: Socket) {
    this.sockets.delete(client.id);
  }

  /**
   * Idempotent: socket.io rooms are a Set, so a repeated join is a no-op and the
   * ack is identical whether the device was already in the room or not. The
   * client re-emits this on every reconnect and whenever it suspects it has
   * missed an update, so it must be safe to call at any rate.
   */
  @SubscribeMessage('join-store')
  async handleJoinStore(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { storeId?: string } | undefined,
  ): Promise<JoinStoreAck> {
    const now = Date.now();
    const rawStoreId = data?.storeId;

    if (typeof rawStoreId !== 'string' || !isUUID(rawStoreId)) {
      this.logger.warn(
        `join-store REJECTED socket=${client.id} storeId=${JSON.stringify(rawStoreId)} — not a uuid`,
      );
      return {
        ok: false,
        code: 'INVALID_STORE_ID',
        error: 'storeId must be a UUID',
        now,
      };
    }

    const storeId = normalizeStoreId(rawStoreId);
    const room = storeRoom(storeId);

    if (!(await this.storeIsJoinable(storeId, client.id))) {
      return {
        ok: false,
        code: 'UNKNOWN_STORE',
        error: `No store exists with id ${storeId}`,
        now,
      };
    }

    const alreadyJoined = client.rooms.has(room);

    // A device belongs to exactly one store. Leaving any other store room keeps
    // a re-pointed device from showing two shops' orders at once.
    for (const stale of [...client.rooms].filter((r) => isStoreRoom(r) && r !== room)) {
      this.sockets.get(client.id)?.intendedRooms.delete(stale);
      await client.leave(stale);
      this.logger.log(`join-store socket=${client.id} left stale room=${stale}`);
    }

    await client.join(room);
    this.sockets.get(client.id)?.intendedRooms.add(room);

    const members = this.roomSize(room);
    this.logger.log(
      `join-store socket=${client.id} storeId=${storeId} room=${room} ` +
        `members=${members} alreadyJoined=${alreadyJoined}`,
    );

    return { ok: true, storeId, room, members, alreadyJoined, now };
  }

  @SubscribeMessage('time:request')
  handleTimeRequest(@ConnectedSocket() client: Socket): { now: number } {
    const now = Date.now();
    // Emitted as an event because that is what the displays listen for; also
    // returned so the same call works as an acknowledged request.
    client.emit('time:sync', { now });
    return { now };
  }

  @SubscribeMessage('chime:replay')
  handleChimeReplay(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { storeId?: string } | undefined,
  ): { ok: boolean } {
    if (typeof data?.storeId !== 'string') return { ok: false };

    const room = storeRoom(data.storeId);
    if (!client.rooms.has(room)) {
      this.logger.warn(
        `chime:replay REFUSED socket=${client.id} room=${room} — socket is not a member`,
      );
      return { ok: false };
    }

    this.server.to(room).emit('chime:play');
    return { ok: true };
  }

  emitOrderCreated(storeId: string, order: Order) {
    this.broadcast(storeId, 'order:created', order);
  }

  emitStatusUpdated(storeId: string, order: Order) {
    this.broadcast(storeId, 'order:status-updated', order);
  }

  /**
   * Answers "is this device still in its store room?" without needing a shell on
   * the mini PC. Compares what each socket asked for against what the socket.io
   * adapter actually holds.
   */
  roomDiagnostics() {
    const rooms = [...this.server.adapter.rooms.entries()]
      .filter(([room]) => isStoreRoom(room))
      .map(([room, members]) => ({
        room,
        storeId: storeIdFromRoom(room),
        members: members.size,
        socketIds: [...members],
      }));

    const sockets = [...this.server.sockets.values()].map((socket) => {
      const record = this.sockets.get(socket.id);
      const intended = [...(record?.intendedRooms ?? [])];
      const actual = [...socket.rooms].filter(isStoreRoom);
      return {
        socketId: socket.id,
        address: record?.address ?? socket.handshake.address,
        transport: socket.conn.transport.name,
        connectedForSeconds: this.livedFor(socket.id),
        intendedRooms: intended,
        actualRooms: actual,
        // true => connected but not receiving: the bug we are chasing.
        drifted: intended.some((room) => !actual.includes(room)),
        neverJoined: intended.length === 0,
      };
    });

    return {
      now: Date.now(),
      socketCount: this.server.sockets.size,
      rooms,
      sockets,
      drifted: sockets.filter((s) => s.drifted).map((s) => s.socketId),
      neverJoined: sockets.filter((s) => s.neverJoined).map((s) => s.socketId),
    };
  }

  private broadcast(storeId: string, event: string, order: Order) {
    const room = storeRoom(storeId);
    const members = this.roomSize(room);

    // A mutation broadcast into an empty room is the signature of a store room
    // that has stopped delivering — worth a warning, since the write succeeded
    // and the client will only find out via its reconcile poll.
    if (members === 0) {
      this.logger.warn(
        `${event} order=${order.orderNumber} room=${room} — NO members, nobody received it`,
      );
    } else {
      this.logger.log(
        `${event} order=${order.orderNumber} room=${room} members=${members}`,
      );
    }

    this.server.to(room).emit(event, order);
  }

  /**
   * The store list is tiny and effectively static, so this is a cache-miss-only
   * DB read. If the lookup itself fails we fail *open*: a database blip must
   * never turn into a shop-wide socket blackout, and the reconcile poll will
   * surface the real error to the device anyway.
   */
  private async storeIsJoinable(storeId: string, socketId: string): Promise<boolean> {
    try {
      const exists = await this.storesService.storeExists(storeId);
      if (!exists) {
        this.logger.warn(
          `join-store REJECTED socket=${socketId} storeId=${storeId} — no such store`,
        );
      }
      return exists;
    } catch (error) {
      this.logger.error(
        `join-store store lookup failed for ${storeId}, joining anyway: ${(error as Error).message}`,
      );
      return true;
    }
  }

  private roomSize(room: string): number {
    return this.server.adapter.rooms.get(room)?.size ?? 0;
  }

  private livedFor(socketId: string): number {
    const connectedAt = this.sockets.get(socketId)?.connectedAt;
    return connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
  }

  private logRoomCensus() {
    // Self-healing sweep. handleDisconnect clears these, but this process is
    // expected to run for weeks: one missed teardown must not accumulate into a
    // leak, and a stale record would also produce phantom "drifted" warnings.
    for (const socketId of this.sockets.keys()) {
      if (!this.server.sockets.has(socketId)) this.sockets.delete(socketId);
    }

    const { socketCount, rooms, drifted, neverJoined } = this.roomDiagnostics();
    if (socketCount === 0 && rooms.length === 0) return; // nothing to say

    const summary = rooms.length
      ? rooms.map((r) => `${r.room}=${r.members}`).join(' ')
      : 'no store rooms';
    this.logger.log(`census     sockets=${socketCount} ${summary}`);

    if (drifted.length) {
      this.logger.error(
        `census     ${drifted.length} socket(s) connected but MISSING their store room: ${drifted.join(', ')}`,
      );
    }
    if (neverJoined.length) {
      this.logger.warn(
        `census     ${neverJoined.length} socket(s) connected but never sent join-store: ${neverJoined.join(', ')}`,
      );
    }
  }
}
