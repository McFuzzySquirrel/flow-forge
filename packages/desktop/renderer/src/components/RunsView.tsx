import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditRecord } from '@flowforge/core';
import type { HumanResponse, PackageSummary, RunSnapshot } from '../../../src/ipc.js';
import { errorMessage, Empty, ErrorInline, shortId } from './common.js';
import { usePolledRun } from './hooks.js';
import { TaskForm } from './TaskForm.js';

function statusLabel(status: RunSnapshot['status']): string {
  switch (status) {
    case 'running': return 'Running';
    case 'waitingForHuman': return 'Waiting for human';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

/**
 * Runs — the generic operator portal. Start workflows from any installed
 * package, watch live progress, drive the human steps as they pause, and see
 * failures. Role-specific task inboxes live in the per-role portals; the
 * kernel enforces authorization here (an attempted resume with the wrong role
 * surfaces as an audited denial card).
 */
export function RunsView({ packages }: { packages: PackageSummary[] }) {
  const [packageId, setPackageId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const [denied, setDenied] = useState<{ message: string; records: AuditRecord[] }>();
  const [busy, setBusy] = useState(false);

  const refreshRuns = useCallback(async () => {
    setRuns(await window.flowforge.listRuns());
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const workflows = useMemo(
    () => packages.find((pkg) => pkg.id === packageId)?.workflows ?? [],
    [packages, packageId]
  );

  useEffect(() => {
    if (workflows.length > 0 && !workflowId) setWorkflowId(workflows[0]!.id);
    if (workflows.length === 0) setWorkflowId('');
  }, [workflows, workflowId]);

  const { run } = usePolledRun(activeRunId);

  const startRun = async () => {
    if (!packageId || !workflowId) return;
    setBusy(true);
    setError(undefined);
    setDenied(undefined);
    try {
      const started = await window.flowforge.startRun(packageId, workflowId);
      setActiveRunId(started.id);
      await refreshRuns();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fetchDeniedRecords = async (runId: string): Promise<AuditRecord[]> => {
    const trail = await window.flowforge.getAuditTrail(runId);
    return trail.records.filter((record) => record.action === 'workflow.authorization.denied');
  };

  const resume = async (response: HumanResponse) => {
    if (!run) return;
    setDenied(undefined);
    setError(undefined);
    try {
      await window.flowforge.resumeRun(run.id, response);
      await refreshRuns();
    } catch (err) {
      const records = await fetchDeniedRecords(run.id).catch(() => []);
      setDenied({ message: errorMessage(err), records });
    }
  };

  return (
    <div>
      <h1 className="ff-page-title">Runs</h1>
      <p className="ff-page-sub">
        Start runs from an installed package and drive the human steps as they pause.
      </p>

      <div className="ff-card" style={{ marginBottom: 20 }}>
        <div className="ff-card-body">
          <div className="ff-form-row">
            <label>Package</label>
            <select
              className="ff-select"
              value={packageId}
              onChange={(event) => {
                setPackageId(event.target.value);
                setWorkflowId('');
              }}
            >
              <option value="">— pick a package —</option>
              {packages.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.branding?.displayName ?? pkg.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ff-form-row">
            <label>Workflow</label>
            <select className="ff-select" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              {workflows.length === 0 && <option value="">— no workflow —</option>}
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.id} ({workflow.nodeCount} nodes)
                </option>
              ))}
            </select>
            <button
              className="ff-btn primary"
              disabled={busy || !packageId || !workflowId}
              onClick={() => void startRun()}
            >
              Start run
            </button>
          </div>
          <ErrorInline error={error} />
        </div>
      </div>

      <div className="ff-grid">
        <section className="ff-card">
          <header className="ff-card-header">
            <h3>Runs</h3>
          </header>
          <div className="ff-card-body" style={{ padding: '6px 16px' }}>
            {runs.length === 0 && <Empty>No runs yet — start one above.</Empty>}
            {runs.map((item) => (
              <div key={item.id} className="ff-run-item">
                <div className="grow">
                  <div>
                    <span className="ff-monospace">{shortId(item.id)}</span> · {item.workflowId}
                  </div>
                  <div className="ff-run-meta">
                    {item.currentNodeId ? `@ ${item.currentNodeId}` : ''}{' '}
                    {item.pending ? `· pending ${item.pending.role}` : ''}
                  </div>
                </div>
                <span className={`ff-status ${item.status}`}>{statusLabel(item.status)}</span>
                <button className="ff-btn ghost" onClick={() => setActiveRunId(item.id)}>
                  Watch
                </button>
              </div>
            ))}
          </div>
        </section>

        {activeRunId && !run && (
          <section className="ff-card">
            <header className="ff-card-header">
              <h3>
                Run <span className="ff-monospace">{shortId(activeRunId)}</span>
              </h3>
            </header>
            <div className="ff-card-body">
              <Empty>Loading run…</Empty>
            </div>
          </section>
        )}

        {run && (
          <section className="ff-card">
            <header className="ff-card-header">
              <h3>
                Run <span className="ff-monospace">{shortId(run.id)}</span>
              </h3>
              <span className={`ff-status ${run.status}`}>{statusLabel(run.status)}</span>
            </header>
            <div className="ff-card-body">
              <dl className="ff-kv">
                <dt>Workflow</dt>
                <dd>{run.workflowId}</dd>
                <dt>Current node</dt>
                <dd>{run.currentNodeId ?? '—'}</dd>
                {run.pending && (
                  <>
                    <dt>Waiting for</dt>
                    <dd>{run.pending.role}</dd>
                  </>
                )}
              </dl>

              {run.status === 'failed' && (
                <div className="ff-failure-card">
                  <h4>Run failed</h4>
                  <pre>{run.error ?? 'No error detail.'}</pre>
                </div>
              )}

              {run.pending && <TaskForm pending={run.pending} onSubmit={(response) => void resume(response)} />}

              {denied && (
                <div className="ff-denied-card">
                  <h4>Authorization denied</h4>
                  <p style={{ margin: '0 0 8px' }}>{denied.message}</p>
                  {denied.records.length > 0 && (
                    <>
                      <p className="ff-muted" style={{ margin: '8px 0 4px', fontSize: 12 }}>
                        Audited denial records:
                      </p>
                      {denied.records.map((record) => (
                        <pre key={record.id}>
                          {record.timestamp} — actor {record.actor.id} · required role{' '}
                          {String(record.detail?.requiredRole ?? '?')} · {String(record.detail?.reason ?? '')}
                        </pre>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
