import { useState } from 'react';
import type { HumanResponse, PendingTaskSnapshot } from '../../../src/ipc.js';

/**
 * Renders the appropriate form for a pending human task. Shared by the
 * teacher and learner portals so both answer tasks identically.
 */
export function TaskForm({
  pending,
  onSubmit,
  busy
}: {
  pending: PendingTaskSnapshot;
  onSubmit: (response: HumanResponse) => void;
  busy?: boolean;
}) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  if (pending.kind === 'input') {
    return (
      <div className="ff-task">
        <div className="ff-task-head">
          Input needed from <strong>{pending.role}</strong>
        </div>
        <p className="ff-task-prompt">{pending.prompt ?? 'Provide input to continue the workflow.'}</p>
        <textarea
          className="ff-textarea"
          rows={3}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Your response"
        />
        <div className="ff-btn-row">
          <button className="ff-btn primary" disabled={busy} onClick={() => onSubmit({ value })}>
            Submit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ff-task">
      <div className="ff-task-head">
        Approval needed from <strong>{pending.role}</strong>
      </div>
      <pre className="ff-pre">{JSON.stringify(pending.subject, null, 2)}</pre>
      <input
        className="ff-input wide"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional)"
      />
      <div className="ff-btn-row">
        <button className="ff-btn primary" disabled={busy} onClick={() => onSubmit({ approved: true, reason })}>
          Approve
        </button>
        <button className="ff-btn danger" disabled={busy} onClick={() => onSubmit({ approved: false, reason })}>
          Reject
        </button>
      </div>
    </div>
  );
}
