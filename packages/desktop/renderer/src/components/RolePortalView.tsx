import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditRecord } from '@flowforge/core';
import type { AuditTrailSnapshot, HumanResponse, RunSnapshot, UserSnapshot } from '../../../src/ipc.js';
import { errorMessage, Empty, ErrorInline, shortId } from './common.js';
import { TaskForm } from './TaskForm.js';

/** Title-case a workflow role for display, e.g. 'compliance-officer' → 'Compliance Officer'. */
export function roleLabel(role: string): string {
  return role
    .split(/[-_ ]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * A per-role participant portal. Shows the task inbox for one workflow role
 * (runs paused waiting for that role) plus feedback for completed runs with
 * audit "why?" links. The role list is derived from installed packages — swap
 * the package and these portals change with it.
 */
export function RolePortalView({
  role,
  user,
  openAudit
}: {
  role: string;
  user?: UserSnapshot;
  openAudit: (filter: { runId?: string; actor?: string }) => void;
}) {
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [trail, setTrail] = useState<AuditTrailSnapshot>();
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busyRunId, setBusyRunId] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [nextRuns, nextTrail] = await Promise.all([
        window.flowforge.listRuns(),
        window.flowforge.getAuditTrail()
      ]);
      setRuns(nextRuns);
      setTrail(nextTrail);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inbox = useMemo(() => runs.filter((run) => run.pending?.role === role), [runs, role]);

  const completed = useMemo(() => runs.filter((run) => run.status === 'completed'), [runs]);

  const agentStepsByRun = useMemo(() => {
    const byRun = new Map<string, AuditRecord[]>();
    for (const record of trail?.records ?? []) {
      if (record.action !== 'agent.step' || !record.workflowRunId) continue;
      const list = byRun.get(record.workflowRunId) ?? [];
      list.push(record);
      byRun.set(record.workflowRunId, list);
    }
    return byRun;
  }, [trail]);

  const canAct = user?.roles.includes(role) ?? false;

  const resume = async (runId: string, response: HumanResponse) => {
    setBusyRunId(runId);
    setError(undefined);
    try {
      await window.flowforge.resumeRun(runId, response);
      setTaskErrors((prev) => ({ ...prev, [runId]: '' }));
      await refresh();
    } catch (err) {
      setTaskErrors((prev) => ({ ...prev, [runId]: errorMessage(err) }));
    } finally {
      setBusyRunId(undefined);
    }
  };

  return (
    <div>
      <h1 className="ff-page-title">{roleLabel(role)} portal</h1>
      <p className="ff-page-sub">
        Tasks waiting for the <strong className="ff-tag">{role}</strong> role.
        {user ? (
          <>
            {' '}
            Signed in as <strong>{user.displayName ?? user.id}</strong>
            {canAct ? ' — you can act on these.' : ` (not signed in with the ${role} role).`}
          </>
        ) : (
          ' Sign in as this role in the Identity view to act.'
        )}{' '}
        The kernel enforces the real authorization.
      </p>

      <ErrorInline error={error} />

      <section className="ff-section">
        <h3>Task inbox</h3>
        {inbox.length === 0 ? (
          <div className="ff-card">
            <div className="ff-card-body">
              <Empty>No pending tasks for this role.</Empty>
            </div>
          </div>
        ) : (
          <div className="ff-grid">
            {inbox.map((run) => (
              <section key={run.id} className="ff-card">
                <header className="ff-card-header">
                  <h3>
                    <span className="ff-monospace">{shortId(run.id)}</span> · {run.workflowId}
                  </h3>
                  <span className="ff-status waitingForHuman">Waiting for human</span>
                </header>
                <div className="ff-card-body">
                  <TaskForm
                    pending={run.pending!}
                    busy={busyRunId === run.id}
                    onSubmit={(response) => void resume(run.id, response)}
                  />
                  {taskErrors[run.id] && <div className="ff-error-card">{taskErrors[run.id]}</div>}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="ff-section">
        <h3>Feedback</h3>
        {completed.length === 0 ? (
          <div className="ff-card">
            <div className="ff-card-body">
              <Empty>No completed runs yet.</Empty>
            </div>
          </div>
        ) : (
          <div className="ff-grid">
            {completed.map((run) => {
              const steps = agentStepsByRun.get(run.id) ?? [];
              return (
                <section key={run.id} className="ff-card">
                  <header className="ff-card-header">
                    <h3>
                      <span className="ff-monospace">{shortId(run.id)}</span> · {run.workflowId}
                    </h3>
                    <span className="ff-status completed">Completed</span>
                  </header>
                  <div className="ff-card-body">
                    <p className="ff-muted" style={{ marginTop: 0, fontSize: 12.5 }}>
                      Summary: run completed. {steps.length} agent step{steps.length === 1 ? '' : 's'} recorded.
                    </p>
                    {steps.length === 0 ? (
                      <p className="ff-muted">No agent-step audit records for this run.</p>
                    ) : (
                      <table className="ff-table">
                        <thead>
                          <tr>
                            <th>Node</th>
                            <th>Agent</th>
                            <th>Score</th>
                            <th>Persona</th>
                            <th>Why?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {steps.map((record) => (
                            <tr key={record.id}>
                              <td className="ff-monospace">{record.nodeId}</td>
                              <td>{record.actor.id}</td>
                              <td>{record.score ?? '—'}</td>
                              <td>{record.actor.persona ?? '—'}</td>
                              <td>
                                <button
                                  className="ff-btn ghost"
                                  onClick={() => openAudit({ runId: run.id })}
                                  title="Open the audit trail pre-filtered to this run"
                                >
                                  why?
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
