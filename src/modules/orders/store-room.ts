/**
 * Single source of truth for the socket.io room that carries a store's order
 * events.
 *
 * Every join and every broadcast must derive the room name from `storeRoom()`.
 * When a device joins `store:5FE1...` while the emitter targets `store:5fe1...`
 * the socket stays connected and silent forever — from the client that is
 * indistinguishable from a dropped connection, and it survives every reconnect
 * because the device keeps rejoining the same wrong room. Normalising here
 * removes that failure mode instead of relying on every call site to agree.
 */

export const STORE_ROOM_PREFIX = 'store:';

/**
 * Store ids arrive from three places that disagree about formatting: the
 * database (lowercase uuid), a hand-edited `VITE_STORE_ID` on each device, and
 * a scanner payload. Trim and lowercase so all three land in the same room.
 */
export const normalizeStoreId = (storeId: string): string =>
  storeId.trim().toLowerCase();

export const storeRoom = (storeId: string): string =>
  `${STORE_ROOM_PREFIX}${normalizeStoreId(storeId)}`;

export const isStoreRoom = (room: string): boolean =>
  room.startsWith(STORE_ROOM_PREFIX);

/** Recovers the store id from a room name, for diagnostics output. */
export const storeIdFromRoom = (room: string): string =>
  room.slice(STORE_ROOM_PREFIX.length);
