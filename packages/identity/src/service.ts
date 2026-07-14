import type { AuditRecord, IdentityConfig, Permission, Principal } from '@flowforge/core';
import { validate } from '@flowforge/core';
import { AuditLog } from '@flowforge/audit';
import {
  MockIdentityProvider,
  OidcIdentityProvider,
  type IdentityProvider,
  type TokenSet
} from './providers.js';
import { PermissionPolicy, RoleMapper, toPrincipal } from './roles.js';
import { InMemorySessionStore, type Session, type SessionStore } from './sessions.js';

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Config-driven registry so a deployment can enable multiple IdPs simultaneously. */
export class IdentityRegistry {
  private providers = new Map<string, IdentityProvider>();

  set(provider: IdentityProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(providerId: string): IdentityProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`No identity provider registered with id '${providerId}'`);
    return provider;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  /** Build a registry from validated identity configuration. */
  static fromConfig(config: IdentityConfig): IdentityRegistry {
    const result = validate('identity', config);
    if (!result.valid) {
      throw new Error(`Invalid identity configuration:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
    }
    const registry = new IdentityRegistry();
    for (const providerConfig of config.providers) {
      registry.set(
        providerConfig.type === 'mock'
          ? new MockIdentityProvider(providerConfig.id)
          : new OidcIdentityProvider(providerConfig)
      );
    }
    return registry;
  }
}

/**
 * Front door for authentication and governance (ADR-0010). Authenticates
 * tokens against a configured provider, maps claims to a normalized Principal
 * with deployment-configured roles, manages sessions, and records every
 * authentication event (login, refresh, denied access) through the
 * hash-chained audit log.
 */
export class IdentityService {
  private readonly roleMapper: RoleMapper;
  private readonly policy: PermissionPolicy;
  private readonly sessionTtlMs: number;
  private readonly groupsClaims: Map<string, string>;

  constructor(
    private readonly config: IdentityConfig,
    readonly registry: IdentityRegistry,
    private readonly audit: AuditLog,
    private readonly sessions: SessionStore = new InMemorySessionStore()
  ) {
    this.roleMapper = new RoleMapper(config.roleMappings);
    this.policy = new PermissionPolicy(config.permissions);
    this.sessionTtlMs = (config.session?.ttlSeconds ?? DEFAULT_SESSION_TTL_MS / 1000) * 1000;
    this.groupsClaims = new Map(config.providers.map((p) => [p.id, p.groupsClaim ?? 'groups']));
  }

  static fromConfig(config: IdentityConfig, audit: AuditLog, sessions?: SessionStore): IdentityService {
    return new IdentityService(config, IdentityRegistry.fromConfig(config), audit, sessions);
  }

  /** Validate tokens with a provider, resolve roles and open an audited session. */
  async login(providerId: string, tokens: TokenSet): Promise<Session> {
    const provider = this.registry.get(providerId);
    let principal: Principal;
    try {
      const claims = await provider.claims(tokens);
      const roles = this.roleMapper.resolve(providerId, claims);
      principal = toPrincipal(providerId, claims, roles, this.groupsClaims.get(providerId));
    } catch (error) {
      this.audit.record({
        actor: { type: 'system', id: 'identity-service' },
        action: 'identity.login.denied',
        detail: { provider: providerId, error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    const session = this.sessions.create(principal, tokens, this.sessionTtlMs);
    this.audit.record({
      actor: this.actor(principal),
      action: 'identity.login',
      detail: { sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() }
    });
    return session;
  }

  /** Resolve a live session; returns undefined when unknown or expired. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Refresh the tokens of a live session, keeping the audit trail. */
  async refresh(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown or expired session '${sessionId}'`);
    if (!session.tokens.refreshToken) throw new Error(`Session '${sessionId}' has no refresh token`);
    const provider = this.registry.get(session.principal.provider);
    const tokens = await provider.refresh(session.tokens.refreshToken);
    this.sessions.revoke(sessionId);
    const renewed = this.sessions.create(session.principal, tokens, this.sessionTtlMs);
    this.audit.record({
      actor: this.actor(session.principal),
      action: 'identity.refresh',
      detail: { previousSessionId: sessionId, sessionId: renewed.id }
    });
    return renewed;
  }

  /** Revoke a session (logout). */
  logout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.revoke(sessionId);
    if (session) {
      this.audit.record({
        actor: this.actor(session.principal),
        action: 'identity.logout',
        detail: { sessionId }
      });
    }
  }

  /** Check a permission grant; denied checks are audited for governance review. */
  authorize(principal: Principal, permission: Permission): boolean {
    const granted = this.policy.granted(principal, permission);
    if (!granted) {
      this.audit.record({
        actor: this.actor(principal),
        action: 'identity.permission.denied',
        detail: { permission }
      });
    }
    return granted;
  }

  /** Governance: the full audit trail attributable to one user. */
  auditTrailForUser(userId: string): AuditRecord[] {
    return this.audit.all().filter((record) => record.actor.type === 'human' && record.actor.id === userId);
  }

  /** Governance: the effective claim-to-role mappings for review. */
  roleMappings(): IdentityConfig['roleMappings'] {
    return structuredClone(this.config.roleMappings);
  }

  private actor(principal: Principal) {
    return {
      type: 'human' as const,
      id: principal.id,
      provider: principal.provider,
      roles: principal.roles
    };
  }
}
