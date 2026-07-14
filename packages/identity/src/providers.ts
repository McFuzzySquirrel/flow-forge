import { createHash, randomBytes } from 'node:crypto';
import type { IdentityProviderConfig } from '@flowforge/core';

/** Claims asserted by an identity provider about an authenticated user. */
export interface ClaimSet {
  sub: string;
  name?: string;
  email?: string;
  [claim: string]: unknown;
}

/** Tokens issued by a provider after a successful flow. */
export interface TokenSet {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt?: number;
}

/** State for an in-flight authorization-code + PKCE flow. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

/** State for an in-flight device-authorization flow (used by the CLI). */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/**
 * Provider abstraction for OpenID Connect identity providers (ADR-0010).
 * Any compliant IdP works: Microsoft Entra ID, Google Workspace, Auth0,
 * Keycloak. Deployments enable providers via identity configuration; the
 * platform normalizes their claims into a FlowForge Principal.
 */
export interface IdentityProvider {
  readonly id: string;
  /** Begin an authorization-code + PKCE flow (interactive surfaces). */
  beginAuthorization(redirectUri: string): Promise<AuthorizationRequest>;
  /** Exchange an authorization code (plus PKCE verifier) for tokens. */
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet>;
  /** Begin a device-authorization flow (headless surfaces such as the CLI). */
  beginDeviceAuthorization(): Promise<DeviceAuthorization>;
  /** Poll for device-flow completion. Resolves undefined while authorization is pending. */
  pollDeviceAuthorization(deviceCode: string): Promise<TokenSet | undefined>;
  /** Refresh an expired token set. */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Validate tokens and return the provider's claims about the user. */
  claims(tokens: TokenSet): Promise<ClaimSet>;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  device_authorization_endpoint?: string;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

function toTokenSet(data: TokenResponse): TokenSet {
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in !== undefined ? Date.now() + data.expires_in * 1000 : undefined
  };
}

/** Generic OIDC provider driven by the issuer's discovery document. */
export class OidcIdentityProvider implements IdentityProvider {
  readonly id: string;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly scopes: string[];
  private discovery?: OidcDiscovery;

  constructor(config: IdentityProviderConfig) {
    if (!config.issuer || !config.clientId) {
      throw new Error(`OIDC provider '${config.id}' requires 'issuer' and 'clientId'`);
    }
    this.id = config.id;
    this.issuer = config.issuer.replace(/\/$/, '');
    this.clientId = config.clientId;
    this.scopes = config.scopes ?? ['openid', 'profile', 'email'];
  }

  private async discover(): Promise<OidcDiscovery> {
    if (!this.discovery) {
      const response = await fetch(`${this.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`OIDC discovery failed for '${this.id}': ${response.status}`);
      this.discovery = (await response.json()) as OidcDiscovery;
    }
    return this.discovery;
  }

  async beginAuthorization(redirectUri: string): Promise<AuthorizationRequest> {
    const discovery = await this.discover();
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(randomBytes(16));
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, codeVerifier };
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet> {
    const discovery = await this.discover();
    return this.tokenRequest(discovery.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: this.clientId
    });
  }

  async beginDeviceAuthorization(): Promise<DeviceAuthorization> {
    const discovery = await this.discover();
    if (!discovery.device_authorization_endpoint) {
      throw new Error(`Provider '${this.id}' does not support the device-authorization flow`);
    }
    const response = await fetch(discovery.device_authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: this.scopes.join(' ') })
    });
    if (!response.ok) throw new Error(`Device authorization failed: ${response.status}`);
    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval?: number;
      expires_in: number;
    };
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      intervalSeconds: data.interval ?? 5,
      expiresInSeconds: data.expires_in
    };
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<TokenSet | undefined> {
    const discovery = await this.discover();
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: this.clientId
      })
    });
    const data = (await response.json()) as TokenResponse;
    if (data.error === 'authorization_pending' || data.error === 'slow_down') return undefined;
    if (data.error) throw new Error(`Device flow failed: ${data.error}`);
    return toTokenSet(data);
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const discovery = await this.discover();
    return this.tokenRequest(discovery.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId
    });
  }

  async claims(tokens: TokenSet): Promise<ClaimSet> {
    const discovery = await this.discover();
    const response = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: 'Bearer ' + tokens.accessToken }
    });
    if (!response.ok) throw new Error(`Token validation failed for '${this.id}': ${response.status}`);
    return (await response.json()) as ClaimSet;
  }

  private async tokenRequest(endpoint: string, params: Record<string, string>): Promise<TokenSet> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    if (!response.ok) throw new Error(`Token request failed for '${this.id}': ${response.status}`);
    return toTokenSet((await response.json()) as TokenResponse);
  }
}

/**
 * Deterministic provider for tests and offline development, mirroring
 * MockModelProvider: access tokens map directly to claim sets.
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly id: string;
  private readonly users: Map<string, ClaimSet>;

  constructor(id = 'mock', users: Record<string, ClaimSet> = {}) {
    this.id = id;
    this.users = new Map(Object.entries(users));
  }

  /** Register a user; the returned token authenticates as that user. */
  addUser(token: string, claims: ClaimSet): this {
    this.users.set(token, claims);
    return this;
  }

  async beginAuthorization(redirectUri: string): Promise<AuthorizationRequest> {
    return { url: `mock://authorize?redirect_uri=${encodeURIComponent(redirectUri)}`, state: 'mock-state', codeVerifier: 'mock-verifier' };
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    return { accessToken: code };
  }

  async beginDeviceAuthorization(): Promise<DeviceAuthorization> {
    return {
      deviceCode: 'mock-device-code',
      userCode: 'MOCK-1234',
      verificationUri: 'mock://device',
      intervalSeconds: 0,
      expiresInSeconds: 300
    };
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<TokenSet | undefined> {
    return { accessToken: deviceCode };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return { accessToken: refreshToken, refreshToken };
  }

  async claims(tokens: TokenSet): Promise<ClaimSet> {
    const claims = this.users.get(tokens.accessToken);
    if (!claims) throw new Error(`Unknown token for mock provider '${this.id}'`);
    return claims;
  }
}
