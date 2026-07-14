# 0010. OIDC identity and role-based authorization

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

FlowForge workflows already declare *who* should act at each human step (`role: "teacher"`,
`role: "student"` on `humanInput` / `humanApproval` nodes), but the engine accepts any free-form
`userId` when a run is resumed. There is no authentication, no permission model, and audit records
carry an unverified identity. For classroom (and any multi-user) deployments we need:

- authenticated users from the identity providers organisations already run — Microsoft Entra ID,
  Google Workspace for Education, Auth0, Keycloak — without coupling FlowForge to any one of them;
- authorization: only a teacher may approve marks, only a student may submit work;
- governance: verified identity (subject, provider, roles) in the hash-chained audit trail, and
  audited authentication events.

Key decisions to settle:

1. OIDC-only, or also plain OAuth 2.0 providers?
2. Where do sessions live — the workflow `StateStore` or a dedicated session store?
3. RBAC only, or RBAC plus per-run participant binding?
4. Are roles defined per workforce package or per deployment?

## Decision

We will standardize on **OpenID Connect (OIDC) only**. OAuth 2.0 alone is an authorization
protocol and does not define who the user is; OIDC adds the identity layer (ID tokens, discovery,
`userinfo`) that every provider we care about supports. A plain-OAuth2 provider can still be
fronted by an OIDC broker such as Keycloak.

We will follow the "everything behind an interface" rule (ADR-0004) and define an
`IdentityProvider` interface in a new `packages/identity` package. It covers the authorization-code
flow with PKCE (interactive surfaces), the device-authorization flow (CLI and other headless
surfaces), token validation/refresh, and mapping of provider claims to a normalized FlowForge
`Principal` (subject id, display name, email, provider, groups, roles). A deterministic
`MockIdentityProvider` mirrors the existing `MockModelProvider` pattern for tests and offline
development.

We will keep configuration schema-first (ADR-0002): an `identity.schema.json` in
`packages/core/schemas` is the source of truth for identity configuration — providers (issuer URL,
client id, scopes), claim-to-role mapping rules, role-to-permission grants, and session policy. A
config-driven `IdentityRegistry` lets one deployment enable several IdPs simultaneously.

We will store sessions in a **dedicated `SessionStore` interface** inside the identity package, not
in the workflow `StateStore`. Sessions are security material with their own lifecycle (expiry,
revocation) and must not be mixed with transactional workflow state (the same separation argument
as ADR-0007); an in-memory implementation ships by default and deployments can swap it.

We will enforce **RBAC plus per-run participant binding**, phased: role-based checks land first —
`WorkflowEngine.resume` requires an authenticated `Principal` and verifies the principal holds the
pending node's role before accepting input or an approval decision, emitting an audited
`workflow.authorization.denied` event otherwise. On top of that, the engine binds a principal to a
role the first time they act in a run, so only the student who submitted may resubmit and only the
assigned teacher may approve.

We will let **workforce packages declare the roles their workflows require** (they already do, on
human nodes) while **deployments map IdP claims to those roles** (e.g. Entra group "Staff" →
FlowForge role "teacher"). Packages stay portable across organisations; identity wiring stays a
deployment concern.

Authentication events (login, token refresh, denied access) and every human workflow action are
recorded through the existing hash-chained `AuditLog` (ADR-0006), with the actor entry extended to
carry the verified provider and roles at the time of action.

## Consequences

Easier: any OIDC-compliant IdP works out of the box; tests run offline against the mock provider;
approvals and submissions are attributable to verified identities; the audit trail answers "who did
what, as which role, asserted by which provider"; packages remain portable because role mapping is
deployment configuration.

Harder: every surface must obtain a `Principal` before resuming a run — the CLI needs a device-code
or dev login step, and callers of `WorkflowEngine.resume` must be updated (a breaking API change
accepted now, while the surface area is small). Plain-OAuth2-only providers require an OIDC broker.
Session revocation and multi-node session sharing need a persistent `SessionStore` implementation
later.

Follow-up work: persistent session store, admin UI for role-mapping management, token-lifetime
policy enforcement beyond expiry, and wiring the desktop/server surfaces to the auth-code + PKCE
flow.
