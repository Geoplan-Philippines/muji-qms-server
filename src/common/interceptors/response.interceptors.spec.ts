import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptors';

describe('ResponseInterceptor', () => {
  it('passes socket acknowledgements through without touching HTTP objects', async () => {
    const context = {
      getType: () => 'ws',
      switchToHttp: () => { throw new Error('No HTTP response for time:request'); },
    } as unknown as ExecutionContext;
    const payload = { now: 123456789 };
    const next = { handle: () => of(payload) } as CallHandler;
    const result = await firstValueFrom(new ResponseInterceptor(new Reflector()).intercept(context, next));
    expect(result).toEqual(payload);
  });

  it('continues wrapping REST queue responses', async () => {
    const context = {
      getType: () => 'http', getHandler: () => function handler() {}, getClass: () => class Controller {},
      switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of([]) } as CallHandler;
    expect(await firstValueFrom(new ResponseInterceptor(new Reflector()).intercept(context, next)))
      .toEqual({ statusCode: 200, message: 'Success', data: [] });
  });
});
