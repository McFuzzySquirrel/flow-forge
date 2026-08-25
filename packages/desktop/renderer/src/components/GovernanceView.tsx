import { useEffect, useState } from 'react';
import type { GovernanceSummary } from '../../../src/ipc.js';
import { errorMessage, Empty, Loading, ErrorInline } from './common.js';

export function GovernanceView({
  openAudit
}: {
  openAudit: (filter: { runId?: string; actor?: string }) => void;
}) {
  const [gov, setGov] = useState<GovernanceSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    window.flowforge
      .getGovernance()
      .then(setGov)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const permissions = Object.entries(gov?.permissions ?? {});
  const ttlSeconds = gov?.session.ttlSeconds;

  return (
    <div>
      <h1 className="ff-page-title">Governance</h1>
      <p className="ff-page-sub">Identity providers, role mappings, permissions, session policy and per-user audit.</p>

      <ErrorInline error={error} />
      {!gov && !error && <Loading />}

      {gov && (
        <>
          <section className="ff-section">
            <h3>Identity providers</h3>
            <div className="ff-card">
              <div className="ff-card-body">
                {gov.providers.length === 0 && <Empty>No identity providers configured.</Empty>}
                {gov.providers.map((provider) => (
                  <span key={provider.id} className="ff-tag">
                    {provider.displayName ?? provider.id} ({provider.type})
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Role mappings</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {gov.roleMappings.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No role mappings configured.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Claim</th>
                        <th>Value</th>
                        <th>Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gov.roleMappings.map((mapping, index) => (
                        <tr key={`${mapping.claim}:${mapping.value}:${index}`}>
                          <td className="ff-monospace">{mapping.claim}</td>
                          <td className="ff-monospace">{mapping.value}</td>
                          <td>{mapping.role}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Permissions</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {permissions.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No explicit permissions configured.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Permission</th>
                        <th>Roles</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permissions.map(([permission, roles]) => (
                        <tr key={permission}>
                          <td className="ff-monospace">{permission}</td>
                          <td>{roles.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Session policy</h3>
            <div className="ff-card">
              <div className="ff-card-body">
                <dl className="ff-kv">
                  <dt>Session TTL</dt>
                  <dd>
                    {ttlSeconds !== undefined
                      ? ttlSeconds >= 3600
                        ? `${(ttlSeconds / 3600).toFixed(1)} hours (${ttlSeconds}s)`
                        : `${ttlSeconds} seconds`
                      : '—'}
                  </dd>
                </dl>
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Per-user audit</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {gov.userAudit.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No audited activity yet.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Actor</th>
                        <th>Provider</th>
                        <th>Roles</th>
                        <th>Records</th>
                        <th>Last action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gov.userAudit.map((row) => (
                        <tr key={row.actorId}>
                          <td>
                            <span
                              className="clickable"
                              onClick={() => openAudit({ actor: row.actorId })}
                              title="Open the audit trail pre-filtered to this actor"
                            >
                              {row.actorId}
                            </span>
                          </td>
                          <td>{row.provider ?? '—'}</td>
                          <td>{row.roles.join(', ') || '—'}</td>
                          <td>{row.recordCount}</td>
                          <td>{row.lastAction ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
