import type { NextFunction, Request, Response } from 'express';

/** Responses that carry tokens or private data: no browser or proxy may cache them. Mount on /api/auth. */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}
