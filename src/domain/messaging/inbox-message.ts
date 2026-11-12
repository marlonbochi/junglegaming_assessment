export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  /** Born processed: it is written inside the financial transaction. */
  static receive(p: { messageId: string; consumerName: string; payloadHash: string; now: Date }): InboxMessage {
    return new InboxMessage({
      messageId: p.messageId,
      consumerName: p.consumerName,
      payloadHash: p.payloadHash,
      receivedAt: p.now,
      processedAt: p.now,
    });
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...s });
  }

  get messageId() { return this.state.messageId; }
  get consumerName() { return this.state.consumerName; }
  get payloadHash() { return this.state.payloadHash; }
  get receivedAt() { return this.state.receivedAt; }
  get processedAt() { return this.state.processedAt; }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this.state.processedAt = at;
  }
}
