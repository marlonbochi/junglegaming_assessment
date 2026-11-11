export type FaultPoint = 'after_ledger_append' | 'before_commit' | 'after_commit_before_ack' | 'after_publish_before_mark';

export interface FaultInjector {
  hit(point: FaultPoint): void;
}
