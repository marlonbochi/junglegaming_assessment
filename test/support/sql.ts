import { SQL } from 'bun';

/** Raw SQL client used by tests to inspect and poke the database directly. */
export function sqlClient(url: string): SQL {
  return new SQL(url, { max: 5 });
}
