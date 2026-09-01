import { useCallback, useEffect, useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';
import type { PackageSummary, UserSnapshot } from '../../src/ipc.js';
import { HomeView } from './components/HomeView.js';
import { RunsView } from './components/RunsView.js';
import { RolePortalView, roleLabel } from './components/RolePortalView.js';
import { AuditView } from './components/AuditView.js';
import { GovernanceView } from './components/GovernanceView.js';
import { IdentityView } from './components/IdentityView.js';
import { WorkflowEditorView } from './editor/WorkflowEditorView.js';

type ViewKey =
  | { kind: 'home' }
  | { kind: 'runs' }
  | { kind: 'role'; role: string }
  | { kind: 'audit' }
  | { kind: 'governance' }
  | { kind: 'identity' }
  | { kind: 'editor' };

export function App() {
  const [view, setView] = useState<ViewKey>({ kind: 'home' });
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [user, setUser] = useState<UserSnapshot>();
  const [auditFilter, setAuditFilter] = useState<{ runId?: string; actor?: string }>({});

  const refreshPackages = useCallback(async () => {
    setPackages(await window.flowforge.listPackages());
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await window.flowforge.getCurrentUser());
  }, []);

  useEffect(() => {
    void refreshPackages();
    void refreshUser();
  }, [refreshPackages, refreshUser]);

  const openAudit = useCallback((filter: { runId?: string; actor?: string }) => {
    setAuditFilter(filter);
    setView({ kind: 'audit' });
  }, []);

  // Portals are data-driven: one entry per distinct human role across the
  // installed packages (swap the package, the menu changes). Nothing is
  // hardcoded to a domain.
  const roles = useMemo(
    () =>
      [...new Set(packages.flatMap((pkg) => pkg.workflows.flatMap((workflow) => workflow.roles)))].sort(),
    [packages]
  );

  return (
    <div className="ff-app">
      <aside className="ff-nav">
        <div className="ff-nav-brand">
          Flow<span>Forge</span>
        </div>
        <nav className="ff-nav-items">
          <button
            className={`ff-nav-item${view.kind === 'home' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'home' })}
          >
            Home / Workforce
          </button>
          <button
            className={`ff-nav-item${view.kind === 'runs' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'runs' })}
          >
            Runs
          </button>
          <div className="ff-nav-group">
            <span className="ff-nav-group-label">Portals</span>
            {roles.length === 0 ? (
              <span className="ff-nav-group-empty">install a package to see its role portals</span>
            ) : (
              roles.map((role) => (
                <button
                  key={role}
                  className={`ff-nav-item${view.kind === 'role' && view.role === role ? ' active' : ''}`}
                  onClick={() => setView({ kind: 'role', role })}
                >
                  {roleLabel(role)}
                </button>
              ))
            )}
          </div>
          <button
            className={`ff-nav-item${view.kind === 'audit' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'audit' })}
          >
            Audit viewer
          </button>
          <button
            className={`ff-nav-item${view.kind === 'governance' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'governance' })}
          >
            Governance
          </button>
          <button
            className={`ff-nav-item${view.kind === 'identity' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'identity' })}
          >
            Identity
          </button>
          <button
            className={`ff-nav-item${view.kind === 'editor' ? ' active' : ''}`}
            onClick={() => setView({ kind: 'editor' })}
          >
            Workflow editor
          </button>
        </nav>
        <div className="ff-nav-footer">
          {user ? (
            <>
              <strong>{user.displayName ?? user.id}</strong>
              {user.roles.join(', ')} · {user.provider}
            </>
          ) : (
            <>
              <strong>Not signed in</strong>
              sign in via the Identity view
            </>
          )}
        </div>
      </aside>

      <main className="ff-content">
        {view.kind === 'home' && <HomeView packages={packages} onPackagesChanged={refreshPackages} />}
        {view.kind === 'runs' && <RunsView packages={packages} />}
        {view.kind === 'role' && <RolePortalView role={view.role} user={user} openAudit={openAudit} />}
        {view.kind === 'audit' && <AuditView initialRunId={auditFilter.runId} initialActor={auditFilter.actor} />}
        {view.kind === 'governance' && <GovernanceView openAudit={openAudit} />}
        {view.kind === 'identity' && <IdentityView packages={packages} user={user} onUserChanged={refreshUser} />}
        {view.kind === 'editor' && <WorkflowEditorView packages={packages} onPackagesChanged={refreshPackages} />}
      </main>
    </div>
  );
}
