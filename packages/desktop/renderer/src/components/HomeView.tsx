import { useEffect, useState } from 'react';
import type { PackageSummary, PackageValidationResult } from '../../../src/ipc.js';
import { errorMessage, Empty, Loading, ErrorInline } from './common.js';

function SigningBadge({ pkg }: { pkg: PackageSummary }) {
  if (pkg.signing?.signed) {
    return (
      <span className="ff-badge green" title="Signature verified at install time">
        ✓ signed{pkg.signing.signerFingerprint ? ` · ${pkg.signing.signerFingerprint}` : ''}
      </span>
    );
  }
  return <span className="ff-badge amber">unsigned</span>;
}

function PackageCard({ pkg, onRemove }: { pkg: PackageSummary; onRemove: () => void }) {
  const headerColor = pkg.branding?.primaryColor ?? '#6366f1';
  return (
    <section className="ff-card">
      <header
        className="ff-card-header"
        style={{ borderTop: `3px solid ${headerColor}`, borderRadius: 'var(--radius) var(--radius) 0 0' }}
      >
        <h3>{pkg.branding?.displayName ?? pkg.name}</h3>
        <span className="ff-badge">{pkg.name} v{pkg.version}</span>
        <SigningBadge pkg={pkg} />
      </header>
      <div className="ff-card-body">
        {pkg.description && <p style={{ marginTop: 0 }}>{pkg.description}</p>}

        <h4 className="ff-muted" style={{ margin: '10px 0 6px', textTransform: 'uppercase', fontSize: 11.5 }}>
          Agents
        </h4>
        <table className="ff-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Model tier</th>
              <th>Skills</th>
              <th>Persona</th>
            </tr>
          </thead>
          <tbody>
            {pkg.agents.map((agent) => (
              <tr key={agent.id}>
                <td>{agent.name}</td>
                <td>{agent.role}</td>
                <td>{agent.modelTier}</td>
                <td>{agent.skills.length > 0 ? agent.skills.join(', ') : '—'}</td>
                <td>{agent.defaultPersona ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h4 className="ff-muted" style={{ margin: '14px 0 6px', textTransform: 'uppercase', fontSize: 11.5 }}>
          Workflows
        </h4>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {pkg.workflows.map((workflow) => (
            <li key={workflow.id}>
              <strong>{workflow.id}</strong> · {workflow.nodeCount} nodes
              {workflow.roles.length > 0 && (
                <>
                  {' '}· human roles:{' '}
                  {workflow.roles.map((role) => (
                    <span key={role} className="ff-tag">{role}</span>
                  ))}
                </>
              )}
            </li>
          ))}
        </ul>

        <div className="ff-btn-row" style={{ marginTop: 14 }}>
          <button className="ff-btn danger" onClick={onRemove}>
            Remove package
          </button>
        </div>
      </div>
    </section>
  );
}

export function HomeView({
  packages,
  onPackagesChanged
}: {
  packages: PackageSummary[];
  onPackagesChanged: () => Promise<void>;
}) {
  const [path, setPath] = useState('');
  const [validation, setValidation] = useState<PackageValidationResult>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void onPackagesChanged().then(() => setLoaded(true));
  }, [onPackagesChanged]);

  const install = async (targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(undefined);
    setValidation(undefined);
    try {
      // The main process classifies the path: package directory vs .workforce
      // archive (a directory can legitimately end in `.workforce`).
      const result = await window.flowforge.installPackage(trimmed);
      if (!result.ok) {
        setValidation(result.validation);
        return;
      }
      setPath('');
      await onPackagesChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    try {
      const selected = await window.flowforge.selectPackagePath();
      if (!selected) return; // user cancelled
      setPath(selected);
      await install(selected);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (packageId: string) => {
    try {
      await window.flowforge.removePackage(packageId);
      await onPackagesChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div>
      <h1 className="ff-page-title">Workforce</h1>
      <p className="ff-page-sub">
        Install a <code className="ff-monospace">.workforce</code> archive or load a package directory.
        Installed packages persist across restarts.
      </p>

      <div className="ff-card" style={{ marginBottom: 20 }}>
        <div className="ff-card-body">
          <div className="ff-form-row">
            <label>Package path</label>
            <input
              className="ff-input wide"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setValidation(undefined);
                setError(undefined);
              }}
              placeholder="/path/to/Grade7-Maths.workforce or /path/to/archive.workforce"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void install(path);
              }}
            />
            <button className="ff-btn" disabled={busy} onClick={() => void browse()}>
              Browse…
            </button>
            <button className="ff-btn primary" disabled={busy || !path.trim()} onClick={() => void install(path)}>
              {busy ? 'Installing…' : 'Install / load'}
            </button>
          </div>

          {validation && !validation.valid && (
            <div className="ff-error-card">
              <strong>Package is invalid — not loaded.</strong>
              <ul className="ff-inline-errors">
                {validation.errors.map((message) => (
                  <li key={message}>• {message}</li>
                ))}
                {validation.graphErrors.map((message) => (
                  <li key={message}>• {message}</li>
                ))}
              </ul>
            </div>
          )}

          <ErrorInline error={error} />
        </div>
      </div>

      <div className="ff-btn-row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, flex: 1 }}>Installed packages</h2>
        <button className="ff-btn ghost" onClick={() => void onPackagesChanged()}>
          Refresh
        </button>
      </div>

      {!loaded ? (
        <Loading />
      ) : packages.length === 0 ? (
        <Empty>No packages installed yet — install one above.</Empty>
      ) : (
        <div className="ff-grid">
          {packages.map((pkg) => (
            <PackageCard key={pkg.id} pkg={pkg} onRemove={() => void remove(pkg.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
