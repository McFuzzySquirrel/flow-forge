/**
 * Identity configuration loading for the desktop app (I.6). The desktop reads
 * a deployment identity config (OIDC providers + role mappings) from
 * `~/.flowforge/identity.json` or `$FLOWFORGE_IDENTITY_CONFIG`. Without one it
 * runs with the dev identity (one mock user per workflow role).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IdentityConfig } from '@flowforge/core';

const DEFAULT_PATH = join(homedir(), '.flowforge', 'identity.json');

export function loadIdentityConfig(): IdentityConfig | undefined {
  const path = process.env.FLOWFORGE_IDENTITY_CONFIG ?? DEFAULT_PATH;
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as IdentityConfig;
  } catch {
    return undefined;
  }
}
