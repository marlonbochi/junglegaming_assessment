export interface Metrics {
  transaction(status: string, kind: string, source: string): void;
  duplicate(source: string, type: string): void;
  retry(component: string): void;
  dlq(reason: string): void;
  lockConflict(): void;
  processingDuration(source: string, seconds: number): void;
  reconciliationMismatch(): void;
  setOutboxLag(seconds: number): void;
  setOutboxPending(n: number): void;
  setPendingReferences(n: number): void;
}

export const noopMetrics: Metrics = {
  transaction: () => {},
  duplicate: () => {},
  retry: () => {},
  dlq: () => {},
  lockConflict: () => {},
  processingDuration: () => {},
  reconciliationMismatch: () => {},
  setOutboxLag: () => {},
  setOutboxPending: () => {},
  setPendingReferences: () => {},
};
