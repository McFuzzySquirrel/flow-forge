import { useCallback, useEffect, useState } from 'react';
import type {
  AuditTrailSnapshot,
  HumanResponse,
  PackageSummary,
  RunSnapshot,
  UserSnapshot
} from '../../src/ipc.js';

/**
 * Milestone 2.1 shell: a thin vertical slice proving the IPC bridge — load a
 * package, sign in as a workflow role (dev identity, ADR-0010), start a run,
 * answer human tasks and watch the audit trail. Everything rendered here is
 * package data; nothing is domain-specific.
 */
export function App() {
  const [packageDir, setPackageDir] = useState('');
  const [pkg, setPkg] = useState<PackageSummary>();
  const [user, setUser] = useState<UserSnapshot>();
  const [run, setRun] = useState<RunSnapshot>();
  const [trail, setTrail] = useState<AuditTrailSnapshot>();
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState('');
  const [reason, setReason] = useState('');

  const guard = useCallback(async (action: () => Promise<void>) => {
    try {
      setError(undefined);
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshTrail = useCallback(async (runId?: string) => {
    setTrail(await window.flowforge.getAuditTrail(runId));
  }, []);

  useEffect(() => {
    void window.flowforge.getCurrentUser().then(setUser);
  }, []);

  const loadPackage = () =>
    guard(async () => {
      const validation = await window.flowforge.validatePackage(packageDir);
      if (!validation.valid) throw new Error(`Invalid package:\n${validation.errors.join('\n')}`);
      setPkg(await window.flowforge.loadPackage(packageDir));
      setUser(undefined);
      setRun(undefined);
    });

  const signIn = (role: string) =>
    guard(async () => {
      setUser(await window.flowforge.signIn(role));
    });

  const startRun = (workflowId: string) =>
    guard(async () => {
      if (!pkg) return;
      const started = await window.flowforge.startRun(pkg.id, workflowId);
      setRun(started);
      await refreshTrail(started.id);
    });

  const resume = (response: HumanResponse) =>
    guard(async () => {
      if (!run) return;
      const resumed = await window.flowforge.resumeRun(run.id, response);
      setRun(resumed);
      setAnswer('');
      setReason('');
      await refreshTrail(resumed.id);
    });

  const roles = [...new Set(pkg?.workflows.flatMap((workflow) => workflow.roles) ?? [])];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem', maxWidth: 900 }}>
      <h1>FlowForge</h1>

      <section>
        <h2>Workforce package</h2>
        <input
          value={packageDir}
          onChange={(event) => setPackageDir(event.target.value)}
          placeholder="Path to a .workforce package"
          style={{ width: '24rem' }}
        />
        <button onClick={loadPackage}>Validate &amp; load</button>
        {pkg && (
          <div>
            <h3>
              {pkg.name} v{pkg.version}
            </h3>
            <p>{pkg.description}</p>
            <h4>Agents</h4>
            <ul>
              {pkg.agents.map((agent) => (
                <li key={agent.id}>
                  <strong>{agent.name}</strong> — {agent.role} ({agent.modelTier}
                  {agent.skills.length > 0 ? `; skills: ${agent.skills.join(', ')}` : ''})
                </li>
              ))}
            </ul>
            <h4>Workflows</h4>
            <ul>
              {pkg.workflows.map((workflow) => (
                <li key={workflow.id}>
                  {workflow.id} ({workflow.nodeCount} nodes){' '}
                  <button onClick={() => startRun(workflow.id)}>Start run</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2>Identity</h2>
        {user ? (
          <p>
            Signed in as <strong>{user.displayName ?? user.id}</strong> ({user.roles.join(', ')} via{' '}
            {user.provider}){' '}
            <button
              onClick={() =>
                guard(async () => {
                  await window.flowforge.signOut();
                  setUser(undefined);
                })
              }
            >
              Sign out
            </button>
          </p>
        ) : (
          <p>
            Not signed in.{' '}
            {roles.map((role) => (
              <button key={role} onClick={() => signIn(role)}>
                Sign in as {role}
              </button>
            ))}
          </p>
        )}
      </section>

      {run && (
        <section>
          <h2>Run {run.id}</h2>
          <p>
            Workflow <strong>{run.workflowId}</strong> — status <strong>{run.status}</strong>
            {run.currentNodeId ? ` @ ${run.currentNodeId}` : ''}
          </p>
          {run.error && <p style={{ color: 'crimson' }}>{run.error}</p>}
          {run.pending && (
            <div style={{ border: '1px solid #ccc', padding: '1rem' }}>
              <p>
                Waiting for <strong>{run.pending.role}</strong> ({run.pending.kind})
              </p>
              {run.pending.kind === 'input' ? (
                <>
                  <p>{run.pending.prompt ?? 'Provide input'}</p>
                  <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} />
                  <button onClick={() => resume({ value: answer })}>Submit</button>
                </>
              ) : (
                <>
                  <pre>{JSON.stringify(run.pending.subject, null, 2)}</pre>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason"
                  />
                  <button onClick={() => resume({ approved: true, reason })}>Approve</button>
                  <button onClick={() => resume({ approved: false, reason })}>Reject</button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {trail && (
        <section>
          <h2>Audit trail ({trail.records.length} records, chain {trail.chainIntact ? 'intact' : 'BROKEN'})</h2>
          <ul>
            {trail.records.map((record) => (
              <li key={record.id}>
                {record.timestamp} — {record.actor.type}:{record.actor.id} — {record.action}
                {record.nodeId ? ` @ ${record.nodeId}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>
          <strong>Error:</strong> {error}
        </p>
      )}
    </main>
  );
}
