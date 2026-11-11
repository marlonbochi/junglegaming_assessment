import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationError, type AppErrorCode } from '../../application/errors';

/** Parses a body, header, param or query with `schema`; failure is a client error with `code`. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(
    private readonly schema: S,
    private readonly code: AppErrorCode = 'INVALID_PAYLOAD',
  ) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ApplicationError(this.code, z.prettifyError(result.error));
    return result.data;
  }
}
