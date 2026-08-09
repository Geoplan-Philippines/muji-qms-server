import { Logger } from '@nestjs/common';

import { env } from './env.config';

/**
 * CORS for a LAN appliance.
 *
 * The frontend is served from a different port on the same mini PC, so every
 * REST call and the socket.io handshake are cross-origin. The devices reach the
 * box by its LAN address, which means an allowlist of literal origins breaks the
 * moment DHCP hands the mini PC a new IP — and the visible symptom of that is
 * every screen in the shop going blank at once.
 *
 * So: explicit origins are always allowed, and private/loopback origins are
 * allowed as well unless `CORS_ALLOW_LAN=false`. The box is on a shop LAN behind
 * a router with no inbound port forwarding; the trade is deliberate, and turning
 * it off is one env var away.
 */

const logger = new Logger('Cors');

/** RFC1918 + loopback + link-local. Anything else must be explicitly listed. */
const PRIVATE_HOSTNAME =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$/i;

const isPrivateOrigin = (origin: string): boolean => {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return PRIVATE_HOSTNAME.test(hostname);
  } catch {
    return false; // not a parseable origin — refuse rather than guess
  }
};

export const isOriginAllowed = (origin?: string): boolean => {
  // No Origin header: same-origin navigation, curl, a health probe, or a
  // non-browser socket.io client. There is no cross-origin risk to gate here.
  if (!origin) return true;
  if (env.CORS_ALLOWED_ORIGINS.includes(origin)) return true;
  return env.CORS_ALLOW_LAN && isPrivateOrigin(origin);
};

/**
 * Shared by `app.enableCors()` and the socket.io handshake so REST and the
 * gateway can never disagree about who is allowed in.
 */
export const corsOriginDelegate = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void => {
  if (isOriginAllowed(origin)) return callback(null, true);
  logger.warn(`Blocked cross-origin request from ${origin}`);
  callback(null, false);
};

export const CORS_METHODS = [
  'GET',
  'HEAD',
  'PUT',
  'PATCH',
  'POST',
  'DELETE',
  'OPTIONS',
];

/** Logged once at boot so a misconfigured allowlist is visible in the service log. */
export const describeCorsPolicy = (): string =>
  `origins=[${env.CORS_ALLOWED_ORIGINS.join(', ') || 'none'}] allowPrivateLan=${env.CORS_ALLOW_LAN}`;
