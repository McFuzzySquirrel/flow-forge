import { useCallback, useEffect, useState } from 'react';
import '@xyflow/react/dist/style.css';
import type { PackageSummary, UserSnapshot } from '../../src/ipc.js';
import { HomeView } from './components/HomeView.js';
import { TeacherView } from './components/TeacherView.js';
import { LearnerView } from './components/LearnerView.js';
import { AuditView } from './components/AuditView.js';
import { GovernanceView } from './components/GovernanceView.js';
import { IdentityView } from './components/IdentityView.js';
import { WorkflowEditorView } from './editor/WorkflowEditorView.js';

type ViewKey = 'home' | 'teacher' | 'learner' | 'audit' | 'governance' | 'identity' | 'editor';

const NAV: { key: ViewKey; label: string }[] = [
  { key: 'home', label: 'Home / Workforce' },
  { key: 'teacher', label: 'Teacher portal' },
  { key: 'learner', label: 'Learner portal' },
  { key: 'audit', label: 'Audit viewer' },
  { key: 'governance', label: 'Governance' },
  { key: 'identity', label: 'Identity' },
  { key: 'editor', label: 'Workflow editor' }
];

export function App() {
  const [view, setView] = useState<ViewKey>('home');
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
    setView('audit');
  }, []);

  return (
    <div className="ff-app">
      <aside className="ff-nav">
        <div className="ff-nav-brand">
          Flow<span>Forge</span>
        </div>
        <nav className="ff-nav-items">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`ff-nav-item${view === item.key ? ' active' : ''}`}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
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
        {view === 'home' && <HomeView packages={packages} onPackagesChanged={refreshPackages} />}
        {view === 'teacher' && <TeacherView packages={packages} />}
        {view === 'learner' && <LearnerView user={user} openAudit={openAudit} />}
        {view === 'audit' && <AuditView initialRunId={auditFilter.runId} initialActor={auditFilter.actor} />}
        {view === 'governance' && <GovernanceView openAudit={openAudit} />}
        {view === 'identity' && <IdentityView packages={packages} user={user} onUserChanged={refreshUser} />}
        {view === 'editor' && <WorkflowEditorView packages={packages} />}
      </main>
    </div>
  );
}
