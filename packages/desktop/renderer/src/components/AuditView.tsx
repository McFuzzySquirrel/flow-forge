import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditTrailSnapshot } from '../../../src/ipc.js';
import { errorMessage, Empty, Loading, ErrorInline, shortId } from './common.js';

export function AuditView({
  initialRunId,
  initialActor
}: {
  initialRunId?: string;
  initialActor?: string;
}) {
  const [trail, setTrail] = useState<AuditTrailSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [runIdFilter, setRunIdFilter] = useState(initialRunId ?? '');
  const [actorFilter, setActorFilter] = useState(initialActor ?? '');
  const [actionFilter, setActionFilter] = useState('');

  const fetchTrail = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setTrail(await window.flowforge.getAuditTrail());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void fetchTrail();
  }, [fetchTrail]);

  const actions = useMemo(
    () => [...new Set((trail?.records ?? []).map((record) => record.action))].sort(),
    [trail]
  );

  const filtered = useMemo(() => {
    const records = trail?.records ?? [];
    return records
      .filter((record) => {
        if (runIdFilter && record.workflowRunId !== runIdFilter) return false;
        if (actorFilter && record.actor.id !== actorFilter) return false;
        if (actionFilter && record.action !== actionFilter) return false;
        return true;
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [trail, runIdFilter, actorFilter, actionFilter]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'flowforge-audit.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h1 className="ff-page-title">Audit viewer</h1>
      <p className="ff-page-sub">
        Hash-chained audit trail. {trail?.records.length ?? 0} records total · {filtered.length} shown.
      </p>

      <div className="ff-card" style={{ marginBottom: 16 }}>
        <div className="ff-card-body">
          <div className="ff-form-row">
            <label>Run id</label>
            <input
              className="ff-input"
              value={runIdFilter}
              onChange={(event) => setRunIdFilter(event.target.value)}
              placeholder="Filter by run id"
            />
          </div>
          <div className="ff-form-row">
            <label>Actor</label>
            <input
              className="ff-input"
              value={actorFilter}
              onChange={(event) => setActorFilter(event.target.value)}
              placeholder="Filter by actor id"
            />
          </div>
          <div className="ff-form-row">
            <label>Action</label>
            <select className="ff-select" value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}>
              <option value="">— all actions —</option>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>
          <div className="ff-btn-row">
            <span className={`ff-badge ${trail?.chainIntact ? 'green' : 'red'}`}>
              {trail?.chainIntact ? '✔ chain intact' : '✘ chain BROKEN'}
            </span>
            <button className="ff-btn" disabled={busy} onClick={() => void fetchTrail()}>
              Verify
            </button>
            <button className="ff-btn" disabled={filtered.length === 0} onClick={exportJson}>
              Export JSON
            </button>
          </div>
          <ErrorInline error={error} />
        </div>
      </div>

      {!trail && !error && <Loading />}

      {trail && filtered.length === 0 && (
        <div className="ff-card">
          <div className="ff-card-body">
            <Empty>No records match the current filters.</Empty>
          </div>
        </div>
      )}

      {trail && filtered.length > 0 && (
        <div className="ff-card">
          <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="ff-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Node</th>
                  <th>Run</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Score</th>
                  <th>Persona</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr key={record.id}>
                    <td className="ff-monospace">{new Date(record.timestamp).toLocaleString()}</td>
                    <td>
                      {record.actor.type}:{record.actor.id}
                    </td>
                    <td>{record.action}</td>
                    <td className="ff-monospace">{record.nodeId ?? '—'}</td>
                    <td className="ff-monospace">
                      {record.workflowRunId ? shortId(record.workflowRunId) : '—'}
                    </td>
                    <td>{record.model?.provider ?? '—'}</td>
                    <td>{record.model?.name ?? '—'}</td>
                    <td>{record.score ?? '—'}</td>
                    <td>{record.actor.persona ?? '—'}</td>
                    <td>
                      <pre className="ff-pre" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                        {String(record.detail?.outputPreview ?? '—')}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
