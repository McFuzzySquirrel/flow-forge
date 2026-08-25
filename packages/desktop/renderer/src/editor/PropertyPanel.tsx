import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkflowDefinition, WorkflowNode } from '@flowforge/core';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ff-form-row">
      <label>{label}</label>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function BranchEditor({
  conditions,
  onChange
}: {
  conditions: { when: string; next: string }[];
  onChange: (conditions: { when: string; next: string }[]) => void;
}) {
  return (
    <div>
      <div className="ff-muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>
        Conditions (first match wins; use <span className="ff-monospace">default</span> for the fallback)
      </div>
      {conditions.map((condition, index) => (
        <div key={`${condition.when}-${index}`} className="ff-form-row" style={{ marginBottom: 6 }}>
          <input
            className="ff-input"
            style={{ flex: 1, minWidth: 0 }}
            value={condition.when}
            placeholder="when (score >= 50)"
            onChange={(event) =>
              onChange(conditions.map((c, i) => (i === index ? { ...c, when: event.target.value } : c)))
            }
          />
          <input
            className="ff-input"
            style={{ flex: 1, minWidth: 0 }}
            value={condition.next}
            placeholder="next node"
            onChange={(event) =>
              onChange(conditions.map((c, i) => (i === index ? { ...c, next: event.target.value } : c)))
            }
          />
          <button className="ff-btn danger" onClick={() => onChange(conditions.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button className="ff-btn ghost" onClick={() => onChange([...conditions, { when: '', next: '' }])}>
        + Add condition
      </button>
    </div>
  );
}

export function PropertyPanel({
  node,
  workflow,
  onPatch,
  onRename,
  onDelete
}: {
  node: WorkflowNode;
  workflow: WorkflowDefinition;
  onPatch: (patch: Partial<WorkflowNode>) => void;
  onRename: (newId: string) => void;
  onDelete: () => void;
}) {
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => setIdDraft(node.id), [node.id]);

  const trimmed = idDraft.trim();
  const idConflict = workflow.nodes.some((candidate) => candidate.id === trimmed && candidate.id !== node.id);

  const commitRename = () => {
    if (trimmed && trimmed !== node.id && !idConflict) onRename(trimmed);
    else setIdDraft(node.id);
  };

  return (
    <div>
      <div className="ff-btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="ff-badge">node:{node.id}</span>
        <button className="ff-btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>

      <Field label="id">
        <input
          className="ff-input"
          value={idDraft}
          onChange={(event) => setIdDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename();
          }}
        />
        {idConflict && <div className="ff-panel-error">Id already in use.</div>}
      </Field>

      <Field label="type">
        <span className="ff-muted">{node.type}</span>
      </Field>

      {node.type !== 'end' && (
        <Field label="next">
          <input
            className="ff-input"
            value={node.next ?? ''}
            onChange={(event) => onPatch({ next: event.target.value || undefined })}
          />
        </Field>
      )}

      {node.type === 'agent' && (
        <>
          <Field label="agent">
            <input className="ff-input" value={node.agent} onChange={(event) => onPatch({ agent: event.target.value })} />
          </Field>
          <Field label="action">
            <textarea
              className="ff-textarea"
              rows={3}
              value={node.action}
              onChange={(event) => onPatch({ action: event.target.value })}
            />
          </Field>
          <Field label="output">
            <input
              className="ff-input"
              value={node.output ?? ''}
              onChange={(event) => onPatch({ output: event.target.value || undefined })}
            />
          </Field>
          <Field label="inputs">
            <input
              className="ff-input"
              value={node.inputs?.join(', ') ?? ''}
              onChange={(event) => onPatch({ inputs: splitList(event.target.value) })}
            />
          </Field>
          <Field label="maxAttempts">
            <input
              type="number"
              min={1}
              className="ff-input"
              value={node.retry?.maxAttempts ?? 1}
              onChange={(event) => onPatch({ retry: { maxAttempts: Math.max(1, Number(event.target.value) || 1) } })}
            />
          </Field>
        </>
      )}

      {node.type === 'humanInput' && (
        <>
          <Field label="role">
            <input className="ff-input" value={node.role} onChange={(event) => onPatch({ role: event.target.value })} />
          </Field>
          <Field label="prompt">
            <textarea
              className="ff-textarea"
              rows={3}
              value={node.prompt ?? ''}
              onChange={(event) => onPatch({ prompt: event.target.value })}
            />
          </Field>
          <Field label="output">
            <input
              className="ff-input"
              value={node.output}
              onChange={(event) => onPatch({ output: event.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'humanApproval' && (
        <>
          <Field label="role">
            <input className="ff-input" value={node.role} onChange={(event) => onPatch({ role: event.target.value })} />
          </Field>
          <Field label="subject">
            <input
              className="ff-input"
              value={node.subject ?? ''}
              onChange={(event) => onPatch({ subject: event.target.value || undefined })}
            />
          </Field>
          <Field label="onApprove">
            <input
              className="ff-input"
              value={node.onApprove ?? ''}
              onChange={(event) => onPatch({ onApprove: event.target.value || undefined })}
            />
          </Field>
          <Field label="onReject">
            <input
              className="ff-input"
              value={node.onReject ?? ''}
              onChange={(event) => onPatch({ onReject: event.target.value || undefined })}
            />
          </Field>
        </>
      )}

      {node.type === 'branch' && (
        <BranchEditor conditions={node.conditions} onChange={(conditions) => onPatch({ conditions })} />
      )}

      {node.type === 'parallel' && (
        <Field label="branches">
          <input
            className="ff-input"
            value={node.branches.join(', ')}
            onChange={(event) => onPatch({ branches: splitList(event.target.value) })}
          />
        </Field>
      )}
    </div>
  );
}
