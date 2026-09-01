import { randomUUID } from 'node:crypto';

export interface MessageRecipient {
  kind: 'user' | 'role' | 'agent';
  id: string;
}

export interface MessageRecord {
  id: string;
  createdAt: string;
  sender: {
    type: 'human' | 'agent' | 'system';
    id: string;
    provider?: string;
    roles?: string[];
  };
  recipient: MessageRecipient;
  content: string;
  workflowRunId?: string;
  packageId?: string;
}

export interface SendMessageInput {
  recipient: MessageRecipient;
  content: string;
  workflowRunId?: string;
  packageId?: string;
}

export interface MessageFilter {
  workflowRunId?: string;
  packageId?: string;
  recipientId?: string;
  recipientKind?: MessageRecipient['kind'];
}

export interface MessagingTransport {
  listMessages(filter?: MessageFilter): Promise<MessageRecord[]>;
  sendMessage(message: MessageRecord): Promise<MessageRecord>;
}

export class InMemoryMessagingTransport implements MessagingTransport {
  private readonly messages: MessageRecord[] = [];

  async listMessages(filter?: MessageFilter): Promise<MessageRecord[]> {
    return this.messages.filter((message) => {
      if (filter?.workflowRunId && message.workflowRunId !== filter.workflowRunId) return false;
      if (filter?.packageId && message.packageId !== filter.packageId) return false;
      if (filter?.recipientId && message.recipient.id !== filter.recipientId) return false;
      if (filter?.recipientKind && message.recipient.kind !== filter.recipientKind) return false;
      return true;
    });
  }

  async sendMessage(message: MessageRecord): Promise<MessageRecord> {
    const stored = { ...message, id: message.id || randomUUID() };
    this.messages.push(stored);
    return stored;
  }
}
