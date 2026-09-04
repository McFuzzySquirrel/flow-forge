# Setting up auth identities

FlowForge uses **OpenID Connect (OIDC)** as its authentication layer (see
[ADR-0010](adr/0010-oidc-identity-and-role-based-authorization.md)). Any
OIDC-compliant identity provider works out of the box. Plain OAuth 2.0 providers
can be fronted by an OIDC broker such as Keycloak.

Identity is configured in a single JSON file. By default the desktop app reads
`~/.flowforge/identity.json`; you can also point to any path via the
`FLOWFORGE_IDENTITY_CONFIG` environment variable.

The desktop app uses a dynamically allocated loopback callback such as
`http://127.0.0.1:<port>/callback`. Do not register a fixed port such as `3478`; configure your
provider to allow loopback redirect URIs according to its client-registration rules. The app opens
the browser and keeps authorization codes and tokens in the trusted Electron main process.

This guide covers five scenarios in order of increasing setup effort:

1. [Dev / offline (mock provider)](#1-dev--offline-mock-provider)
2. [Microsoft Entra ID (Azure AD)](#2-microsoft-entra-id-azure-ad)
3. [Google Workspace](#3-google-workspace)
4. [Auth0 and Keycloak](#4-auth0-and-keycloak)
5. [Personal email accounts (Outlook / Gmail)](#5-personal-email-accounts-outlook--gmail)

To test both personal identities in one deployment, configure two OIDC providers and map each
email address to the role needed by the workflow. The desktop app can list both providers and start
the selected authorization-code + PKCE flow. The CLI device-flow path uses the first configured
provider in the identity file, so use a separate identity file per provider when testing the CLI.

```json
{
  "providers": [
    {
      "id": "microsoft-personal",
      "type": "oidc",
      "displayName": "Microsoft personal",
      "issuer": "https://login.microsoftonline.com/consumers/v2.0",
      "clientId": "<microsoft-client-id>",
      "scopes": ["openid", "profile", "email"]
    },
    {
      "id": "gmail",
      "type": "oidc",
      "displayName": "Google personal",
      "issuer": "https://accounts.google.com",
      "clientId": "<google-client-id>",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "microsoft-personal",
      "claim": "email",
      "value": "teacher@outlook.com",
      "role": "teacher"
    },
    {
      "provider": "gmail",
      "claim": "email",
      "value": "student@gmail.com",
      "role": "student"
    }
  ]
}
```

---

## Config file anatomy

Every `identity.json` has three top-level sections:

```jsonc
{
  // One or more IdP entries – all enabled simultaneously.
  "providers": [ /* ... */ ],

  // Map IdP claims (e.g. group membership) to FlowForge roles.
  "roleMappings": [ /* ... */ ],

  // Optional: per-role permission grants and session lifetime.
  "permissions": { /* ... */ },
  "session": { "ttlSeconds": 28800 }
}
```

**Providers** — each entry needs a unique `id` (kebab-case), a `type`
(`oidc` / `mock`), and — for OIDC providers — `issuer` and `clientId`.

**Role mappings** — FlowForge roles (`teacher`, `student`, …) are declared by
workforce packages on `humanInput` / `humanApproval` nodes. Deployments map IdP
claims onto those roles here. If you omit `provider`, the mapping applies to
every configured provider.

**Permissions** — omit this section (or the `permissions` key) and any
authenticated user who holds at least one role is granted all actions. In
production, list the actions each role may perform:

```jsonc
"permissions": {
  "teacher": ["workflow.start", "workflow.approve", "audit.view"],
  "student": ["workflow.start", "workflow.input"]
}
```

Available actions: `workflow.start`, `workflow.input`, `workflow.approve`,
`audit.view`, `package.manage`.

---

## 1. Dev / offline (mock provider)

The mock provider is built in — no external IdP required. Tokens are
deterministic strings you choose; the provider maps each string to a fixed set
of claims. It is suitable for local development, automated tests, and CI.

```json
{
  "providers": [
    {
      "id": "mock",
      "type": "mock"
    }
  ],
  "roleMappings": [
    { "claim": "role", "value": "teacher", "role": "teacher" },
    { "claim": "role", "value": "student", "role": "student" }
  ]
}
```

In code or tests, build the service with `IdentityService.fromConfig(config,
audit)` and add users directly to `MockIdentityProvider.addUser(token, claims)`:

```ts
import { MockIdentityProvider } from '@flowforge/identity';

const provider = new MockIdentityProvider('mock');
provider.addUser('teacher-token', { sub: 'u1', name: 'Alice', role: 'teacher' });
provider.addUser('student-token', { sub: 'u2', name: 'Bob',   role: 'student' });
```

Passing `{ accessToken: 'teacher-token' }` to `IdentityService.login('mock', …)`
will resolve Alice as a `teacher`.

The **desktop app** shows a "Dev identity" login button for each configured role
when a mock provider is present — no credentials needed.

> **Avoid in production.** The mock provider skips all real authentication; it
> is intended for development only.

---

## 2. Microsoft Entra ID (Azure AD)

### Register an application

1. In [portal.azure.com](https://portal.azure.com) → **Entra ID** →
   **App registrations** → **New registration**.
2. Give the app a name (e.g. *FlowForge*) and set the redirect URI to match your
   deployment surface:
   - Desktop (Electron): dynamic loopback callback, for example `http://127.0.0.1:<port>/callback`
   - Server: `https://<your-host>/auth/callback`
3. Note the **Application (client) ID** and **Directory (tenant) ID**.
4. Under **Authentication**, enable *Access tokens* and *ID tokens*.
5. Under **Token configuration**, add optional claim **`groups`** (type: *ID*).
   In large tenants where a user is in more than 150 groups you may need to
   configure the *Groups claim* to emit group IDs or use the `hasgroups` claim
   with application roles instead.
6. Do **not** create a client secret — FlowForge uses public-client PKCE; no
   secret is needed.

### Configuration

Replace `<tenant-id>` and `<client-id>` with the values from the portal:

```json
{
  "providers": [
    {
      "id": "entra",
      "type": "oidc",
      "displayName": "Microsoft",
      "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
      "clientId": "<client-id>",
      "scopes": ["openid", "profile", "email"],
      "groupsClaim": "groups"
    }
  ],
  "roleMappings": [
    {
      "provider": "entra",
      "claim": "groups",
      "value": "<object-id-of-staff-group>",
      "role": "teacher"
    },
    {
      "provider": "entra",
      "claim": "groups",
      "value": "<object-id-of-students-group>",
      "role": "student"
    }
  ]
}
```

> **Tip:** The `groups` claim in Entra ID v2 tokens contains **object IDs**, not
> display names. Copy the group object ID from **Entra ID → Groups → \<group\> →
> Object ID**.

### CLI device-code login

The CLI uses the device-authorization flow (RFC 8628). Entra ID supports this
natively. Run a workflow with an identity configuration:

```bash
flowforge run fixtures/Grade7-Maths.workforce assignment \
  --identity ~/.flowforge/identity.json
```

When a human step is reached, you will be shown a short code and a URL
(`microsoft.com/devicelogin`). Enter the code in a browser, sign in with your Microsoft account,
and the CLI receives a token automatically. The provider used is the first configured provider in
the identity file.

---

## 3. Google Workspace

### Register an OAuth client

1. In [console.cloud.google.com](https://console.cloud.google.com) →
   **APIs & Services** → **Credentials** → **Create credentials** → **OAuth
   client ID**.
2. Choose *Desktop app* (or *Web application* if deploying a server).
3. For a web application add the redirect URI:
   the dynamic loopback callback shown by the desktop app (or your production URL).
4. Note the **Client ID**. No client secret is needed for public clients.
5. Under **OAuth consent screen**, add the scopes `openid`, `email`, and
   `profile`.

Google Workspace does not emit group memberships in OIDC tokens by default.
The most practical approach is to map on the `hd` (hosted domain) claim or on
`email`:

```json
{
  "providers": [
    {
      "id": "google",
      "type": "oidc",
      "displayName": "Google",
      "issuer": "https://accounts.google.com",
      "clientId": "<client-id>.apps.googleusercontent.com",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "google",
      "claim": "email",
      "value": "alice@school.edu",
      "role": "teacher"
    },
    {
      "provider": "google",
      "claim": "hd",
      "value": "school.edu",
      "role": "student"
    }
  ]
}
```

This grants `teacher` to a specific address and `student` to everyone on the
`school.edu` domain. Any claim present in the Google `userinfo` response can be
used in a mapping.

> **Group memberships via Google Directory.** Google's OIDC tokens do not carry
> group data. If you need group-based roles, either (a) maintain the role
> mappings by email address / domain as above, or (b) front Google with a
> Keycloak broker that fetches Directory API groups and adds them as a custom
> claim (see [Keycloak](#4-auth0-and-keycloak) below).

> **Device-code flow.** Google supports the device-authorization flow for
> *Google TV and limited-input device* OAuth clients. If your project only uses
> the interactive (desktop/browser) flow, the standard *Desktop app* client type
> is simpler.

---

## 4. Auth0 and Keycloak

Both support standard OIDC discovery and work with the generic
`OidcIdentityProvider`. They are particularly useful when you want to:

- federate multiple upstream identity providers (Microsoft + Google + SAML
  enterprise IdP) behind a single FlowForge provider entry, or
- enrich tokens with custom group claims sourced from a directory or database.

### Auth0

1. In [manage.auth0.com](https://manage.auth0.com) → **Applications** → **Create
   Application** → *Regular Web Application* (for server) or *Native* (for
   desktop/CLI).
2. Allow the dynamic loopback callback used by the desktop app, for example `http://127.0.0.1:<port>/callback`.
3. Enable **Refresh Token Rotation** in the application settings.
4. To emit roles as a token claim, create an **Action** in the Auth0 pipeline
   that writes user roles into a custom namespace claim:

   ```js
   // Auth0 Action: add roles to ID / access token
   exports.onExecutePostLogin = async (event, api) => {
     const ns = 'https://flowforge.dev/claims/';
     api.idToken.setCustomClaim(ns + 'roles', event.authorization?.roles ?? []);
   };
   ```

5. Create Auth0 **Roles** (`teacher`, `student`) and assign them to users.

```json
{
  "providers": [
    {
      "id": "auth0",
      "type": "oidc",
      "displayName": "Auth0",
      "issuer": "https://<your-tenant>.auth0.com/",
      "clientId": "<client-id>",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "auth0",
      "claim": "https://flowforge.dev/claims/roles",
      "value": "teacher",
      "role": "teacher"
    },
    {
      "provider": "auth0",
      "claim": "https://flowforge.dev/claims/roles",
      "value": "student",
      "role": "student"
    }
  ]
}
```

### Keycloak

1. In your Keycloak realm → **Clients** → **Create client**.
2. Set **Client authentication** to *Off* (public client, PKCE).
3. Allow the dynamic loopback callback used by the desktop app, for example `http://127.0.0.1:<port>/callback`.
4. Create **Realm roles** (`teacher`, `student`) and assign them to users (or
   map from LDAP groups).
5. Add a **Client scope** that maps realm roles into the `realm_access.roles`
   claim (this is Keycloak's default behaviour).

```json
{
  "providers": [
    {
      "id": "keycloak",
      "type": "oidc",
      "displayName": "Keycloak",
      "issuer": "https://<keycloak-host>/realms/<realm>",
      "clientId": "<client-id>",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "keycloak",
      "claim": "realm_access",
      "value": "teacher",
      "role": "teacher"
    },
    {
      "provider": "keycloak",
      "claim": "realm_access",
      "value": "student",
      "role": "student"
    }
  ]
}
```

> **Note:** The `realm_access` claim in Keycloak tokens is an object of the form
> `{ "roles": ["teacher", "student"] }`. The `RoleMapper` checks whether the
> claim value equals the `value` field or whether the value appears in the array,
> so listing individual role names here works correctly.

---

## 5. Personal email accounts (Outlook / Gmail)

This section covers **consumer** Microsoft accounts (Outlook, Hotmail, Live) and
**personal** Google accounts (Gmail) — accounts that individuals own, not
accounts managed by an organisation's Entra ID tenant or Google Workspace
subscription. Users authenticate with their own username and password through
Microsoft's or Google's standard login pages; FlowForge never sees or stores any
credentials.

Because personal accounts belong to no organisation directory, there are no
groups to query. Roles must be mapped by individual `email` (or `sub`) values.
This works well for small, known user lists; for larger or unknown lists, front
these providers with Auth0 or Keycloak (see [Auth0 and Keycloak](#4-auth0-and-keycloak))
and manage roles there instead.

### Personal Microsoft accounts (Outlook / Hotmail / Live)

#### Register an application

1. In [portal.azure.com](https://portal.azure.com) → **Entra ID** →
   **App registrations** → **New registration**.
2. Under **Supported account types**, choose *Personal Microsoft accounts only*
   (or *Accounts in any organizational directory and personal Microsoft accounts*
   if you also need Entra ID users from any tenant).
3. Set the redirect URI to match your deployment surface:
   - Desktop (Electron): dynamic loopback callback, for example `http://127.0.0.1:<port>/callback`
   - Server: `https://<your-host>/auth/callback`
4. Note the **Application (client) ID**.
5. Under **Authentication**, enable *Access tokens* and *ID tokens*.
6. Do **not** create a client secret — FlowForge uses public-client PKCE.

#### Configuration

Use the `consumers` issuer, which is the Microsoft endpoint for personal
accounts. Replace `<client-id>` with the Application ID from the portal:

```json
{
  "providers": [
    {
      "id": "microsoft-personal",
      "type": "oidc",
      "displayName": "Microsoft (personal)",
      "issuer": "https://login.microsoftonline.com/consumers/v2.0",
      "clientId": "<client-id>",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "microsoft-personal",
      "claim": "email",
      "value": "alice@outlook.com",
      "role": "teacher"
    },
    {
      "provider": "microsoft-personal",
      "claim": "email",
      "value": "bob@hotmail.com",
      "role": "student"
    }
  ]
}
```

> **No `groupsClaim` for personal accounts.** Personal Microsoft accounts are
> not members of an Entra ID directory, so the `groups` claim is never emitted.
> Map roles by `email` (or `sub`) as shown above.

> **`consumers` vs `common`.** Using `https://login.microsoftonline.com/consumers/v2.0`
> restricts sign-in to personal accounts only. If you use `common` instead,
> both work and personal accounts and Entra ID (work/school) accounts are
> accepted — in that case add a second role-mapping block scoped to the
> appropriate provider for each account type.

---

### Personal Google accounts (Gmail)

#### Register an OAuth client

1. In [console.cloud.google.com](https://console.cloud.google.com) →
   **APIs & Services** → **Credentials** → **Create credentials** → **OAuth
   client ID**.
2. Choose *Desktop app* (or *Web application* for a server deployment).
3. On the **OAuth consent screen**, set *User type* to **External** so that
   accounts outside your organisation can sign in.
4. Add the scopes `openid`, `email`, and `profile`.
5. For a web application add the redirect URI:
   the dynamic loopback callback shown by the desktop app (or your production URL).
6. Note the **Client ID**. No client secret is needed for public clients.

#### Configuration

The issuer is the same as for Google Workspace. The critical difference is that
personal Gmail accounts do **not** carry an `hd` (hosted domain) claim, so
map roles by `email` or `sub`:

```json
{
  "providers": [
    {
      "id": "gmail",
      "type": "oidc",
      "displayName": "Google (personal)",
      "issuer": "https://accounts.google.com",
      "clientId": "<client-id>.apps.googleusercontent.com",
      "scopes": ["openid", "profile", "email"]
    }
  ],
  "roleMappings": [
    {
      "provider": "gmail",
      "claim": "email",
      "value": "alice@gmail.com",
      "role": "teacher"
    },
    {
      "provider": "gmail",
      "claim": "email",
      "value": "bob@gmail.com",
      "role": "student"
    }
  ]
}
```

> **No `hd` claim.** Google only includes `hd` in tokens for Workspace
> (organisational) accounts. Do not use `hd` mappings for personal Gmail —
> they will never match. Use `email` or the stable `sub` identifier instead.

> **Open enrollment warning.** If you want *any* Google-authenticated user to
> receive a role, you could add a catch-all mapping using `sub` with a wildcard
> — but this is not supported by the `RoleMapper` and is intentionally absent.
> Anyone who authenticates successfully but matches no role mapping will have
> no roles and will be denied access. This is the safe default. Add each
> permitted user's `email` explicitly.

---

### Common caveats for personal accounts

| Consideration | Detail |
|---|---|
| **No directory / group support** | Personal accounts have no organisation directory. Roles must be listed by `email` or `sub`. This does not scale to large or frequently changing user lists. |
| **Scale** | For more than a handful of known users, front these providers with Auth0 or Keycloak ([section 4](#4-auth0-and-keycloak)) and manage role assignments there. |
| **Password management** | Passwords are owned entirely by Microsoft or Google. FlowForge never receives, stores, or resets them. Users click the provider's login button and authenticate on the provider's own page. |
| **Account verification** | A successful OIDC login only proves the user controls that email address at that provider. It does not verify identity beyond what the provider asserts. |

---

## Using multiple providers simultaneously

You can list as many providers as you need. The desktop app shows a login button
for each one. Role mappings can be scoped to a specific provider with the
`"provider"` field, or omitted to apply to all:

```json
{
  "providers": [
    { "id": "entra", "type": "oidc", "issuer": "...", "clientId": "..." },
    { "id": "google", "type": "oidc", "issuer": "https://accounts.google.com", "clientId": "..." }
  ],
  "roleMappings": [
    { "provider": "entra",  "claim": "groups", "value": "<staff-group-id>", "role": "teacher" },
    { "provider": "google", "claim": "hd",     "value": "school.edu",       "role": "student" }
  ]
}
```

---

## Session lifetime

By default sessions last **8 hours**. Override with:

```json
"session": { "ttlSeconds": 3600 }
```

Sessions are stored in memory by default and lost on restart. For persistent
sessions, supply a custom `SessionStore` implementation when constructing
`IdentityService` directly.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `OIDC discovery failed for '<id>': 404` | Wrong `issuer` URL — check the `.well-known/openid-configuration` endpoint manually. |
| Login succeeds but user has no roles | Role mapping `claim` / `value` mismatch — inspect the raw claims with `IdentityService.login` and log `claims` to confirm the claim name and value the IdP is sending. |
| `Provider '<id>' does not support the device-authorization flow` | The IdP discovery document has no `device_authorization_endpoint`. Use the interactive auth-code flow instead, or switch to an IdP/broker that supports RFC 8628. |
| Desktop app shows "Dev identity" button unexpectedly | A `mock` provider is listed in `identity.json`. Remove it for production deployments. |
| `Unknown or expired session` | Session TTL elapsed. Re-authenticate or increase `session.ttlSeconds`. |
