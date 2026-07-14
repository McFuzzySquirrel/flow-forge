import { describe, expect, it } from 'vitest';
import type { IdentityConfig } from '@flowforge/core';
import { AuditLog } from '@flowforge/audit';
import {
  IdentityRegistry,
  IdentityService,
  InMemorySessionStore,
  MockIdentityProvider,
  PermissionPolicy,
  RoleMapper,
  toPrincipal
} from './index.js';

const config: IdentityConfig = {
  providers: [{ id: 'school', type: 'mock' }],
  roleMappings: [
    { claim: 'groups', value: 'Staff', role: 'teacher' },
    { claim: 'groups', value: 'Year7', role: 'student' },
    { provider: 'other', claim: 'groups', value: 'Staff', role: 'admin' }
  ],
  permissions: {
    teacher: ['workflow.start', 'workflow.input', 'workflow.approve', 'audit.view'],
    student: ['workflow.input']
  },
  session: { ttlSeconds: 3600 }
};

function makeService() {
  const audit = new AuditLog();
  const service = IdentityService.fromConfig(config, audit);
  const provider = service.registry.get('school') as MockIdentityProvider;
  provider.addUser('token-teacher', { sub: 'u-1', name: 'Ms Patel', email: 'patel@school.example', groups: ['Staff'] });
  provider.addUser('token-student', { sub: 'u-2', name: 'Alex', groups: ['Year7'] });
  return { service, audit };
}

describe('RoleMapper and Principal mapping', () => {
  it('maps claims to roles, honouring provider-scoped mappings', () => {
    const mapper = new RoleMapper(config.roleMappings);
    expect(mapper.resolve('school', { sub: 'u-1', groups: ['Staff', 'Chess Club'] })).toEqual(['teacher']);
    expect(mapper.resolve('school', { sub: 'u-2', groups: ['Year7'] })).toEqual(['student']);
    // provider-scoped mapping only applies to its provider
    expect(mapper.resolve('other', { sub: 'u-3', groups: ['Staff'] })).toEqual(['teacher', 'admin']);
    expect(mapper.resolve('school', { sub: 'u-4', groups: [] })).toEqual([]);
  });

  it('normalizes claims into a Principal', () => {
    const principal = toPrincipal(
      'school',
      { sub: 'u-1', name: 'Ms Patel', email: 'patel@school.example', groups: ['Staff'] },
      ['teacher']
    );
    expect(principal).toEqual({
      id: 'u-1',
      displayName: 'Ms Patel',
      email: 'patel@school.example',
      provider: 'school',
      groups: ['Staff'],
      roles: ['teacher']
    });
  });
});

describe('PermissionPolicy', () => {
  const teacher = { id: 'u-1', provider: 'school', roles: ['teacher'] };
  const student = { id: 'u-2', provider: 'school', roles: ['student'] };

  it('enforces configured grants', () => {
    const policy = new PermissionPolicy(config.permissions);
    expect(policy.granted(teacher, 'workflow.approve')).toBe(true);
    expect(policy.granted(student, 'workflow.approve')).toBe(false);
    expect(policy.granted(student, 'workflow.input')).toBe(true);
  });

  it('is permissive for any role-holder when no grants are configured (dev default)', () => {
    const policy = new PermissionPolicy(undefined);
    expect(policy.granted(student, 'workflow.approve')).toBe(true);
    expect(policy.granted({ id: 'u-3', provider: 'school', roles: [] }, 'workflow.input')).toBe(false);
  });
});

describe('IdentityRegistry', () => {
  it('builds providers from validated configuration', () => {
    const registry = IdentityRegistry.fromConfig(config);
    expect(registry.ids()).toEqual(['school']);
    expect(registry.get('school')).toBeInstanceOf(MockIdentityProvider);
  });

  it('rejects invalid configuration against identity.schema.json', () => {
    expect(() =>
      IdentityRegistry.fromConfig({ providers: [], roleMappings: [] } as IdentityConfig)
    ).toThrow(/Invalid identity configuration/);
  });

  it('requires issuer and clientId for oidc providers', () => {
    expect(() =>
      IdentityRegistry.fromConfig({
        providers: [{ id: 'entra', type: 'oidc' }],
        roleMappings: []
      })
    ).toThrow(/requires 'issuer' and 'clientId'/);
  });
});

describe('IdentityService', () => {
  it('logs a user in, mapping claims to roles, and audits the event', async () => {
    const { service, audit } = makeService();
    const session = await service.login('school', { accessToken: 'token-teacher' });
    expect(session.principal).toMatchObject({ id: 'u-1', provider: 'school', roles: ['teacher'] });
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(service.getSession(session.id)?.principal.id).toBe('u-1');

    const login = audit.all().find((r) => r.action === 'identity.login')!;
    expect(login.actor).toMatchObject({ type: 'human', id: 'u-1', provider: 'school', roles: ['teacher'] });
    expect(audit.verify()).toBe(-1);
  });

  it('audits denied logins for unknown tokens', async () => {
    const { service, audit } = makeService();
    await expect(service.login('school', { accessToken: 'stolen' })).rejects.toThrow(/Unknown token/);
    expect(audit.all().some((r) => r.action === 'identity.login.denied')).toBe(true);
  });

  it('refreshes a session with an audited event', async () => {
    const { service, audit } = makeService();
    const provider = service.registry.get('school') as MockIdentityProvider;
    provider.addUser('refreshed', { sub: 'u-1', name: 'Ms Patel', groups: ['Staff'] });
    const session = await service.login('school', { accessToken: 'token-teacher', refreshToken: 'refreshed' });
    const renewed = await service.refresh(session.id);
    expect(renewed.id).not.toBe(session.id);
    expect(service.getSession(session.id)).toBeUndefined();
    expect(audit.all().some((r) => r.action === 'identity.refresh')).toBe(true);
  });

  it('logs out with an audited event and audits denied permission checks', async () => {
    const { service, audit } = makeService();
    const session = await service.login('school', { accessToken: 'token-student' });
    expect(service.authorize(session.principal, 'workflow.approve')).toBe(false);
    expect(audit.all().some((r) => r.action === 'identity.permission.denied')).toBe(true);
    service.logout(session.id);
    expect(service.getSession(session.id)).toBeUndefined();
    expect(audit.all().some((r) => r.action === 'identity.logout')).toBe(true);
  });

  it('exposes governance views: per-user audit trail and role mappings', async () => {
    const { service } = makeService();
    await service.login('school', { accessToken: 'token-teacher' });
    await service.login('school', { accessToken: 'token-student' });
    const trail = service.auditTrailForUser('u-1');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.action).toBe('identity.login');
    expect(service.roleMappings()).toEqual(config.roleMappings);
  });
});

describe('InMemorySessionStore', () => {
  it('expires sessions after their ttl', async () => {
    const store = new InMemorySessionStore();
    const principal = { id: 'u-1', provider: 'school', roles: ['teacher'] };
    const session = store.create(principal, { accessToken: 't' }, 5);
    expect(store.get(session.id)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get(session.id)).toBeUndefined();
  });

  it('revokes sessions', () => {
    const store = new InMemorySessionStore();
    const session = store.create({ id: 'u-1', provider: 'school', roles: [] }, { accessToken: 't' }, 60_000);
    store.revoke(session.id);
    expect(store.get(session.id)).toBeUndefined();
  });
});
