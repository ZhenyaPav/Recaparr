import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export function bearerAuth(expectedToken: string): RequestHandler {
  const expected = Buffer.from(expectedToken);
  return (request, response, next) => {
    const authorization = request.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
