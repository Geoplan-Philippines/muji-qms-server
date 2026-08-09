import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Opts a route out of the global `{ statusCode, message, data }` envelope.
 *
 * Reserved for endpoints whose body is a contract with something that is not
 * this project's frontend — a monitor or a deployment script reading
 * GET /api/v1/health, for instance.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
