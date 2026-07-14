import type { IdentityConfig, Permission, Principal, RoleMapping } from '@flowforge/core';
import type { ClaimSet } from './providers.js';

/**
 * Resolves FlowForge roles from provider claims using deployment-configured
 * mappings (ADR-0010). Packages declare the roles their workflows require;
 * deployments map IdP claims (e.g. group 'Staff') onto those roles.
 */
export class RoleMapper {
  constructor(private readonly mappings: RoleMapping[]) {}

  resolve(providerId: string, claims: ClaimSet): string[] {
    const roles = new Set<string>();
    for (const mapping of this.mappings) {
      if (mapping.provider && mapping.provider !== providerId) continue;
      const claimValue = claims[mapping.claim];
      const matches = Array.isArray(claimValue)
        ? claimValue.includes(mapping.value)
        : claimValue === mapping.value;
      if (matches) roles.add(mapping.role);
    }
    return [...roles];
  }
}

/** Maps validated provider claims plus resolved roles to a normalized Principal. */
export function toPrincipal(providerId: string, claims: ClaimSet, roles: string[], groupsClaim = 'groups'): Principal {
  const groups = claims[groupsClaim];
  return {
    id: claims.sub,
    displayName: claims.name,
    email: claims.email,
    provider: providerId,
    groups: Array.isArray(groups) ? (groups as string[]) : undefined,
    roles
  };
}

/**
 * Role-to-permission policy from identity configuration. When no permission
 * grants are configured, holding any role grants all permissions (a permissive
 * default suitable for development; production deployments should configure
 * explicit grants).
 */
export class PermissionPolicy {
  constructor(private readonly grants?: IdentityConfig['permissions']) {}

  granted(principal: Principal, permission: Permission): boolean {
    if (!this.grants) return principal.roles.length > 0;
    return principal.roles.some((role) => this.grants?.[role]?.includes(permission) ?? false);
  }
}
