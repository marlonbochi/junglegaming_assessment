import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export type CheckStatus = 'up' | 'down';

export interface Readiness {
  status: 'ok' | 'error';
  checks: { database: CheckStatus; queue: CheckStatus };
}

const CHECK_TIMEOUT_MS = 2000;

/** Spec §8: liveness is the process itself; readiness needs the database and the wager queue. */
export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<Readiness> {
    const [database, queue] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('SELECT 1')),
      check(() => this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }))),
    ]);
    return { status: database === 'up' && queue === 'up' ? 'ok' : 'error', checks: { database, queue } };
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
