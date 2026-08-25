import { useEffect, useMemo, useState } from 'react';
import type { IdentityProviderSummary, PackageSummary, UserSnapshot } from '../../../src/ipc.js';
import { errorMessage, Empty, ErrorInline } from './common.js';

export function IdentityView({
  packages,
  user,
  onUserChanged
}: {
  packages: PackageSummary[];
  user?: UserSnapshot;
  onUserChanged: () => void;
}) {
  const [providers, setProviders] = useState<IdentityProviderSummary[]>([]);
  const [oidcBusy, setOidcBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const roles = useMemo(
    () => [...new Set(packages.flatMap((pkg) => pkg.workflows.flatMap((workflow) => workflow.roles)))].sort(),
    [packages]
  );

  useEffect(() => {
    window.flowforge
      .listIdentityProviders()
      .then(setProviders)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const signInRole = async (role: string) => {
    setError(undefined);
    try {
      await window.flowforge.signIn(role);
      await onUserChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const signInOidc = async (providerId: string) => {
    setError(undefined);
    setOidcBusy(providerId);
    try {
      await window.flowforge.signInWithOidc(providerId);
      await onUserChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOidcBusy(undefined);
    }
  };

  const signOut = async () => {
    setError(undefined);
    try {
      await window.flowforge.signOut();
      await onUserChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const oidcProviders = providers.filter((provider) => provider.type === 'oidc');

  return (
    <div>
      <h1 className="ff-page-title">Identity</h1>
      <p className="ff-page-sub">Sign in with the dev identity (one mock user per role) or an OIDC provider.</p>

      <ErrorInline error={error} />

      <div className="ff-grid">
        <section className="ff-card">
          <header className="ff-card-header">
            <h3>Current user</h3>
          </header>
          <div className="ff-card-body">
            {user ? (
              <>
                <dl className="ff-kv">
                  <dt>Name</dt>
                  <dd>{user.displayName ?? user.id}</dd>
                  <dt>Provider</dt>
                  <dd>{user.provider}</dd>
                  <dt>Roles</dt>
                  <dd>{user.roles.join(', ') || '—'}</dd>
                </dl>
                <div className="ff-btn-row" style={{ marginTop: 12 }}>
                  <button className="ff-btn danger" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <Empty>Not signed in.</Empty>
            )}
          </div>
        </section>

        <section className="ff-card">
          <header className="ff-card-header">
            <h3>Dev identity</h3>
          </header>
          <div className="ff-card-body">
            {roles.length === 0 ? (
              <Empty>Install a package with human workflow roles first.</Empty>
            ) : (
              <>
                <p className="ff-muted" style={{ marginTop: 0 }}>
                  One click signs in as the workflow role using the dev mock provider.
                </p>
                <div className="ff-btn-row">
                  {roles.map((role) => (
                    <button key={role} className="ff-btn" onClick={() => void signInRole(role)}>
                      Sign in as {role}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        <section className="ff-card">
          <header className="ff-card-header">
            <h3>OIDC providers</h3>
          </header>
          <div className="ff-card-body">
            {oidcProviders.length === 0 ? (
              <Empty>No OIDC providers configured.</Empty>
            ) : (
              <>
                {oidcProviders.map((provider) => (
                  <div key={provider.id} className="ff-btn-row" style={{ marginBottom: 10 }}>
                    <button
                      className="ff-btn primary"
                      disabled={oidcBusy !== undefined}
                      onClick={() => void signInOidc(provider.id)}
                    >
                      Sign in with {provider.displayName ?? provider.id}
                    </button>
                    {oidcBusy === provider.id && (
                      <span className="ff-progress-note">Check your browser to complete sign-in…</span>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
