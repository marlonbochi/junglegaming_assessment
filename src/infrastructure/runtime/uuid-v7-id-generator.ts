import type { IdGenerator } from '../../application/ports/clock';

export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
