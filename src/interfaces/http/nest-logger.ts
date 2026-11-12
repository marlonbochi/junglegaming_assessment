import type { LoggerService } from '@nestjs/common';
import type pino from 'pino';

/** Routes Nest's own logs (bootstrap, route mapping, internal errors) through pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: pino.Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /** Nest passes the context as the last parameter (and a stack before it for errors). */
  private write(level: pino.Level, message: unknown, params: unknown[]): void {
    const context = typeof params.at(-1) === 'string' ? params.at(-1) : undefined;
    this.logger[level]({ context }, String(message));
  }
}
