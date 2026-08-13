import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';

import { PostHogExceptionFilter } from './posthog-exception.filter';

interface Captured {
  error: Error;
  userId?: string;
  properties: Record<string, any>;
}

class FakePostHogService {
  captured: Captured[] = [];

  captureException(
    error: Error,
    userId: string | undefined,
    properties: Record<string, any>,
  ) {
    this.captured.push({ error, userId, properties });
  }
}

function makeHost(request: Record<string, any>) {
  const response = {
    status() {
      return this;
    },
    json() {
      return this;
    },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

function makeRequest(overrides: Record<string, any> = {}) {
  return {
    url: '/api/sharing/accept',
    method: 'POST',
    headers: { 'user-agent': 'jest' },
    ip: '127.0.0.1',
    query: {},
    ...overrides,
  };
}

function runFilter(exception: unknown, request: Record<string, any>) {
  const posthog = new FakePostHogService();
  const filter = new PostHogExceptionFilter(posthog as any);

  filter.catch(exception, makeHost(request));

  expect(posthog.captured).toHaveLength(1);
  return posthog.captured[0];
}

describe('PostHogExceptionFilter', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('query parameter redaction', () => {
    // /api/sharing/accept takes a live invite token as ?token=, so an
    // exception on that route used to hand a working credential to a third
    // party analytics vendor.
    it('redacts an invite token rather than shipping it to PostHog', () => {
      const token = 'inv_live_9f3c2b7a41d8e605';
      const captured = runFilter(
        new BadRequestException('Invitation already accepted'),
        makeRequest({ query: { token } }),
      );

      expect(captured.properties.queryParams.token).toBe('[REDACTED]');
      expect(JSON.stringify(captured.properties)).not.toContain(token);
    });

    it.each([
      ['token', 'tok_secret_value'],
      ['inviteToken', 'inv_secret_value'],
      ['access_token', 'at_secret_value'],
      ['apiKey', 'ak_secret_value'],
      ['password', 'hunter2_secret_value'],
      ['signature', 'sig_secret_value'],
      ['code', 'oauth_secret_value'],
    ])('redacts %s', (name, value) => {
      const captured = runFilter(
        new Error('boom'),
        makeRequest({ query: { [name]: value } }),
      );

      expect(captured.properties.queryParams[name]).toBe('[REDACTED]');
      expect(JSON.stringify(captured.properties)).not.toContain(value);
    });

    it('keeps ordinary parameters, which are the ones worth debugging with', () => {
      const captured = runFilter(
        new Error('boom'),
        makeRequest({ query: { page: '2', sort: 'createdAt' } }),
      );

      expect(captured.properties.queryParams).toEqual({
        page: '2',
        sort: 'createdAt',
      });
    });

    it('truncates an oversized value under an unrecognised name', () => {
      const captured = runFilter(
        new Error('boom'),
        makeRequest({ query: { note: 'x'.repeat(5000) } }),
      );

      expect(captured.properties.queryParams.note.length).toBeLessThan(300);
      expect(captured.properties.queryParams.note).toContain('[truncated]');
    });

    it('redacts inside nested query values', () => {
      const captured = runFilter(
        new Error('boom'),
        makeRequest({ query: { filter: { token: 'nested_secret_value' } } }),
      );

      expect(JSON.stringify(captured.properties)).not.toContain(
        'nested_secret_value',
      );
    });
  });

  describe('exception payload bounds', () => {
    it('does not walk an arbitrarily deep object', () => {
      // 30 levels, well past the depth limit.
      let deep: any = { leaf: 'deep_secret_value' };
      for (let i = 0; i < 30; i += 1) {
        deep = { nested: deep };
      }
      const error = new Error('boom');
      (error as any).context = deep;

      const captured = runFilter(error, makeRequest());

      expect(JSON.stringify(captured.properties)).not.toContain(
        'deep_secret_value',
      );
    });

    it('truncates a very long string on the exception', () => {
      const error = new Error('boom');
      (error as any).body = 'y'.repeat(20000);

      const captured = runFilter(error, makeRequest());

      expect(captured.properties.exceptionRaw.length).toBeLessThan(20000);
    });

    it('redacts credential-looking properties on the exception itself', () => {
      const error = new Error('boom');
      (error as any).authorization = 'Bearer live_secret_value';

      const captured = runFilter(error, makeRequest());

      expect(JSON.stringify(captured.properties.exceptionJson)).not.toContain(
        'live_secret_value',
      );
    });

    it('still reports enough to identify the failure', () => {
      const captured = runFilter(
        new BadRequestException('Token is required'),
        makeRequest(),
      );

      expect(captured.properties.path).toBe('/api/sharing/accept');
      expect(captured.properties.method).toBe('POST');
      expect(captured.properties.statusCode).toBe(400);
      expect(captured.properties.exceptionRaw).toContain('Token is required');
    });
  });
});
