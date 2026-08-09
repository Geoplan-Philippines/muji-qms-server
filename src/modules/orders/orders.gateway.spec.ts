import { Namespace, Socket } from 'socket.io';

import { OrdersGateway } from './orders.gateway';
import { StoresService } from '../stores/stores.service';
import { storeRoom } from './store-room';

const STORE_ID = '3f9a1c2e-5b74-4d18-9a63-0c8e2f7b41da';

/** Minimal stand-ins for the socket.io objects the gateway actually touches. */
class FakeSocket {
  readonly rooms = new Set<string>();
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly handshake = {
    address: '192.168.1.50',
    headers: {} as Record<string, string>,
    query: {},
  };
  readonly conn = { transport: { name: 'websocket' }, on: jest.fn() };

  constructor(
    readonly id: string,
    private readonly adapterRooms: Map<string, Set<string>>,
  ) {}

  join(room: string) {
    this.rooms.add(room);
    const members = this.adapterRooms.get(room) ?? new Set<string>();
    members.add(this.id);
    this.adapterRooms.set(room, members);
  }

  leave(room: string) {
    this.rooms.delete(room);
    const members = this.adapterRooms.get(room);
    members?.delete(this.id);
    if (members && members.size === 0) this.adapterRooms.delete(room);
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return true;
  }

  on() {
    return this;
  }
}

const setup = (storeExists: jest.Mock = jest.fn().mockResolvedValue(true)) => {
  const adapterRooms = new Map<string, Set<string>>();
  const sockets = new Map<string, FakeSocket>();
  /** Everything broadcast through `namespace.to(room).emit(...)`. */
  const broadcasts: Array<{ room: string; event: string; payload: unknown }> = [];

  const namespace = {
    adapter: { rooms: adapterRooms, on: jest.fn() },
    sockets,
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        broadcasts.push({ room, event, payload });
        return true;
      },
    }),
  } as unknown as Namespace;

  const storesService = { storeExists } as unknown as StoresService;
  const gateway = new OrdersGateway(storesService);
  (gateway as unknown as { server: Namespace }).server = namespace;

  const connect = (id: string) => {
    const socket = new FakeSocket(id, adapterRooms);
    sockets.set(id, socket);
    gateway.handleConnection(socket as unknown as Socket);
    return socket;
  };

  return { gateway, connect, broadcasts, adapterRooms, storeExists };
};

describe('OrdersGateway', () => {
  /**
   * Regression guard. The global ThrottlerGuard reaches websocket handlers and
   * calls `res.header(...)` on what is actually the message payload, throwing
   * `TypeError: res.header is not a function` before any handler body runs — so
   * without this metadata every message handler here is dead and no device ever
   * joins a store room.
   */
  it('opts out of the global throttler, which cannot handle a websocket context', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', OrdersGateway)).toBe(true);
  });

  describe('join-store', () => {
    it('acknowledges a valid join and reports room membership', async () => {
      const { gateway, connect } = setup();
      const socket = connect('socket-a');

      const ack = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID,
      });

      expect(ack).toMatchObject({
        ok: true,
        storeId: STORE_ID,
        room: `store:${STORE_ID}`,
        members: 1,
        alreadyJoined: false,
      });
      expect(socket.rooms.has(`store:${STORE_ID}`)).toBe(true);
    });

    it('is idempotent — a repeated join leaves one membership and still acks', async () => {
      const { gateway, connect, adapterRooms } = setup();
      const socket = connect('socket-a');

      await gateway.handleJoinStore(socket as unknown as Socket, { storeId: STORE_ID });
      const second = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID,
      });

      expect(second).toMatchObject({ ok: true, members: 1, alreadyJoined: true });
      expect(adapterRooms.get(`store:${STORE_ID}`)?.size).toBe(1);
    });

    it('rejects a storeId that is not a uuid instead of joining nothing', async () => {
      const { gateway, connect } = setup();
      const socket = connect('socket-a');

      const ack = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: 'not-a-uuid',
      });

      expect(ack).toMatchObject({ ok: false, code: 'INVALID_STORE_ID' });
      expect(socket.rooms.size).toBe(0);
    });

    it('rejects an unknown store rather than silently joining an empty room', async () => {
      const storeExists = jest.fn().mockResolvedValue(false);
      const { gateway, connect } = setup(storeExists);
      const socket = connect('socket-a');

      const ack = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID,
      });

      expect(ack).toMatchObject({ ok: false, code: 'UNKNOWN_STORE' });
      expect(socket.rooms.size).toBe(0);
    });

    it('fails open when the store lookup itself errors, so a DB blip is not a blackout', async () => {
      const storeExists = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const { gateway, connect } = setup(storeExists);
      const socket = connect('socket-a');

      const ack = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID,
      });

      expect(ack).toMatchObject({ ok: true });
      expect(socket.rooms.has(`store:${STORE_ID}`)).toBe(true);
    });

    it('leaves a previous store room so a re-pointed device cannot see two shops', async () => {
      const { gateway, connect } = setup();
      const socket = connect('socket-a');
      const other = '11111111-2222-4333-8444-555555555555';

      const first = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: other,
      });
      expect(first).toMatchObject({ ok: true, room: `store:${other}` });

      await gateway.handleJoinStore(socket as unknown as Socket, { storeId: STORE_ID });

      expect([...socket.rooms]).toEqual([`store:${STORE_ID}`]);
    });
  });

  describe('room key agreement', () => {
    /**
     * The regression that matters most: a device joining with a differently
     * cased uuid than the one the database returns would sit connected and
     * silent forever.
     */
    it('delivers to a device that joined with an upper-case storeId', async () => {
      const { gateway, connect, broadcasts } = setup();
      const socket = connect('socket-a');

      await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID.toUpperCase(),
      });

      // The emitter always uses the canonical lower-case id from Prisma.
      gateway.emitOrderCreated(STORE_ID, { orderNumber: 'A100' } as never);

      expect(socket.rooms.has(storeRoom(STORE_ID))).toBe(true);
      expect(broadcasts).toEqual([
        { room: `store:${STORE_ID}`, event: 'order:created', payload: { orderNumber: 'A100' } },
      ]);
    });

    it('broadcasts status updates to the same room join-store uses', async () => {
      const { gateway, connect, broadcasts } = setup();
      const socket = connect('socket-a');

      const ack = await gateway.handleJoinStore(socket as unknown as Socket, {
        storeId: STORE_ID,
      });
      gateway.emitStatusUpdated(STORE_ID, { orderNumber: 'A100' } as never);

      expect(ack).toMatchObject({ ok: true });
      expect(broadcasts[0].event).toBe('order:status-updated');
      expect(broadcasts[0].room).toBe((ack as { room: string }).room);
    });
  });

  describe('time sync', () => {
    it('pushes the clock on connect without being asked', () => {
      const { connect } = setup();
      const socket = connect('socket-a');

      expect(socket.emitted[0].event).toBe('time:sync');
      expect(typeof (socket.emitted[0].payload as { now: number }).now).toBe('number');
    });

    it('answers time:request with both an event and an ack', () => {
      const { gateway, connect } = setup();
      const socket = connect('socket-a');
      socket.emitted.length = 0;

      const result = gateway.handleTimeRequest(socket as unknown as Socket);

      expect(typeof result.now).toBe('number');
      expect(socket.emitted).toEqual([{ event: 'time:sync', payload: { now: result.now } }]);
    });
  });

  describe('diagnostics', () => {
    it('flags a socket that wanted a room but is no longer in it', async () => {
      const { gateway, connect } = setup();
      const socket = connect('socket-a');
      await gateway.handleJoinStore(socket as unknown as Socket, { storeId: STORE_ID });

      // Simulate the fault: membership vanishes while the socket stays connected.
      socket.leave(storeRoom(STORE_ID));

      const diagnostics = gateway.roomDiagnostics();
      expect(diagnostics.drifted).toEqual(['socket-a']);
      expect(diagnostics.sockets[0].intendedRooms).toEqual([storeRoom(STORE_ID)]);
      expect(diagnostics.sockets[0].actualRooms).toEqual([]);
    });

    it('flags a socket that connected but never sent join-store', () => {
      const { gateway, connect } = setup();
      connect('socket-a');

      expect(gateway.roomDiagnostics().neverJoined).toEqual(['socket-a']);
    });
  });
});
