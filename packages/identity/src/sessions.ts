import { randomUUID } from 'node:crypto';
import type { Principal } from '@flowforge/core';
import type { TokenSet } from './providers.js';

export interface Session {
  id: string;
  principal: Principal;
  tokens: TokenSet;
  /** Epoch milliseconds when the session expires (deployment session policy). */
  expiresAt: number;
}

/**
 * Dedicated, pluggable session persistence (ADR-0010). Sessions are security
 * material with their own lifecycle and deliberately live outside the
 * workflow StateStore.
 */
export interface SessionStore {
  create(principal: Principal, tokens: TokenSet, ttlMs: number): Session;
  get(sessionId: string): Session | undefined;
  revoke(sessionId: string): void;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  create(principal: Principal, tokens: TokenSet, ttlMs: number): Session {
    const session: Session = {
      id: randomUUID(),
      principal: structuredClone(principal),
      tokens: { ...tokens },
      expiresAt: Date.now() + ttlMs
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return structuredClone(session);
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
