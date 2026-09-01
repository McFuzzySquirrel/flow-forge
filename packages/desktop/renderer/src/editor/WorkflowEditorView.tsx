import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type NodeProps,
  type NodeTypes,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange
} from '@xyflow/react';
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from '@flowforge/core';
import type { HumanResponse, PackageSummary } from '../../../src/ipc.js';
import { errorMessage, ErrorInline, Empty } from '../components/common.js';
import { usePolledRun } from '../components/hooks.js';
import { TaskForm } from '../components/TaskForm.js';
import { FlowNodeComponent } from './FlowNode.js';
import { PropertyPanel } from './PropertyPanel.js';
import {
  createNode,
  edgesFromWorkflow,
  nodesFromWorkflow,
  patchNode,
  removeEdgesFromWorkflow,
  removeNodesFromWorkflow,
  retargetWorkflow,
  uniqueNodeId,
  type FlowEdge,
  type FlowNode
} from './graph.js';
import { validateWorkflow } from './validation.js';
import { advanceDryRun, createDryRun, respondDryRun, type DryRunState } from './dryRun.js';

const NODE_TYPES_OPTIONS: WorkflowNodeType[] = ['agent', 'humanInput', 'humanApproval', 'branch', 'parallel', 'end'];

export function WorkflowEditorView({
  packages,
  onPackagesChanged
}: {
  packages: PackageSummary[];
  onPackagesChanged: () => Promise<void>;
}) {
  const [packageId, setPackageId] = useState('');
  const [workflowId, setWorkflowId] = useState('');

  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>('agent');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string>();

  const [watchInput, setWatchInput] = useState('');
  const [watchTarget, setWatchTarget] = useState<string>();
  const [dryRun, setDryRun] = useState<DryRunState | null>(null);

  const workflowRef = useRef<WorkflowDefinition | null>(null);
  useEffect(() => {
    workflowRef.current = workflow;
  }, [workflow]);
  const edgesRef = useRef<FlowEdge[]>([]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const workflows = useMemo(
    () => packages.find((pkg) => pkg.id === packageId)?.workflows ?? [],
    [packages, packageId]
  );
  const activePackage = useMemo(
    () => packages.find((pkg) => pkg.id === packageId),
    [packages, packageId]
  );

  useEffect(() => {
    if (packages.length === 0) return;
    if (!packageId || !packages.some((pkg) => pkg.id === packageId)) {
      const first = packages[0];
      if (first) {
        setPackageId(first.id);
        setWorkflowId(first.workflows[0]?.id ?? '');
      }
    }
  }, [packages, packageId]);

  useEffect(() => {
    const pkg = packages.find((candidate) => candidate.id === packageId);
    if (pkg && (!workflowId || !pkg.workflows.some((candidate) => candidate.id === workflowId))) {
      setWorkflowId(pkg.workflows[0]?.id ?? '');
    }
  }, [packages, packageId, workflowId]);

  const applyWorkflow = useCallback((next: WorkflowDefinition) => {
    setWorkflow(next);
    setNodes((prev) => nodesFromWorkflow(next, prev));
    setEdges(edgesFromWorkflow(next));
    setValidationErrors(validateWorkflow(next));
    setDryRun(null);
  }, []);

  useEffect(() => {
    if (!packageId || !workflowId) {
      setWorkflow(null);
      setNodes([]);
      setEdges([]);
      setValidationErrors([]);
      setDryRun(null);
      return;
    }
    let cancelled = false;
    setLoadError(undefined);
    window.flowforge
      .getWorkflow(packageId, workflowId)
      .then((fetched) => {
        if (!cancelled) applyWorkflow(fetched);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };

    const handleAgentSkillsChange = async (skills: string[]) => {
      if (!packageId || selectedNode?.type !== 'agent') return;
      setLoadError(undefined);
      try {
        await window.flowforge.updateAgentSkills(packageId, selectedNode.agent, skills);
        await onPackagesChanged();
        setSaveMessage(`Updated skills for agent ${selectedNode.agent}.`);
      } catch (err) {
        setLoadError(errorMessage(err));
      }
    };
  }, [packageId, workflowId, applyWorkflow]);

  const onNodesChange = useCallback<OnNodesChange<FlowNode>>((changes) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, []);

  const onEdgesChange = useCallback<OnEdgesChange<FlowEdge>>(
    (changes) => {
      const removals = changes.filter((change) => change.type === 'remove');
      if (removals.length > 0) {
        const removedIds = new Set(removals.map((change) => change.id));
        const removedEdges = edgesRef.current.filter((edge) => removedIds.has(edge.id));
        const wf = workflowRef.current;
        if (wf && removedEdges.length > 0) {
          applyWorkflow(removeEdgesFromWorkflow(wf, removedEdges));
        }
      }
      setEdges((prev) => applyEdgeChanges(changes, prev));
    },
    [applyWorkflow]
  );

  const onNodesDelete = useCallback(
    (deleted: FlowNode[]) => {
      const wf = workflowRef.current;
      if (!wf || deleted.length === 0) return;
      applyWorkflow(removeNodesFromWorkflow(wf, new Set(deleted.map((node) => node.id))));
    },
    [applyWorkflow]
  );

  const onConnect = useCallback<OnConnect>(
    (connection: Connection) => {
      const wf = workflowRef.current;
      if (!wf || !connection.source || !connection.target || connection.source === connection.target) return;
      const sourceNode = wf.nodes.find((node) => node.id === connection.source);
      if (!sourceNode) return;
      const handle = connection.sourceHandle ?? 'out';

      let next: WorkflowDefinition;
      if (sourceNode.type === 'branch') {
        const conditions = sourceNode.conditions;
        const defaultIndex = conditions.findIndex((condition) => condition.when === 'default');
        const updated = conditions.map((condition, index) =>
          index === defaultIndex ? { ...condition, next: connection.target! } : condition
        );
        next = patchNode(wf, connection.source, {
          conditions: defaultIndex >= 0 ? updated : [...conditions, { when: 'default', next: connection.target! }]
        });
      } else if (sourceNode.type === 'parallel') {
        next = patchNode(wf, connection.source, {
          branches: sourceNode.branches.includes(connection.target)
            ? sourceNode.branches
            : [...sourceNode.branches, connection.target]
        });
      } else if (sourceNode.type === 'humanApproval') {
        next = handle === 'reject'
          ? patchNode(wf, connection.source, { onReject: connection.target })
          : patchNode(wf, connection.source, { onApprove: connection.target });
      } else if (sourceNode.type === 'end') {
        return;
      } else {
        next = patchNode(wf, connection.source, { next: connection.target });
      }
      applyWorkflow(next);
    },
    [applyWorkflow]
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      const wf = workflowRef.current;
      if (!wf) return;
      applyWorkflow(removeNodesFromWorkflow(wf, new Set([nodeId])));
    },
    [applyWorkflow]
  );

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      workflow: (props: NodeProps<FlowNode>) => <FlowNodeComponent {...props} onDelete={deleteNode} />
    }),
    [deleteNode]
  );

  const selectedNodeId = nodes.find((node) => node.selected)?.id;
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId);
  const selectedAgentSummary =
    selectedNode?.type === 'agent' ? activePackage?.agents.find((agent) => agent.id === selectedNode.agent) : undefined;

  const patchSelectedNode = useCallback(
    (patch: Partial<WorkflowNode>) => {
      const wf = workflowRef.current;
      if (!wf || !selectedNodeId) return;
      applyWorkflow(patchNode(wf, selectedNodeId, patch));
    },
    [applyWorkflow, selectedNodeId]
  );

  const renameSelectedNode = useCallback(
    (newId: string) => {
      const wf = workflowRef.current;
      if (!wf || !selectedNodeId || !newId.trim() || newId === selectedNodeId) return;
      if (wf.nodes.some((node) => node.id === newId)) return;
      applyWorkflow(retargetWorkflow(wf, selectedNodeId, newId));
    },
    [applyWorkflow, selectedNodeId]
  );

  const addNode = useCallback(() => {
    const wf = workflowRef.current;
    if (!wf) return;
    const id = uniqueNodeId(newNodeType, wf.nodes.map((node) => node.id));
    applyWorkflow({ ...wf, nodes: [...wf.nodes, createNode(newNodeType, id)] });
  }, [applyWorkflow, newNodeType]);

  const resetWorkflow = useCallback(() => {
    if (!packageId || !workflowId) return;
    window.flowforge
      .getWorkflow(packageId, workflowId)
      .then(applyWorkflow)
      .catch((err) => setLoadError(errorMessage(err)));
  }, [packageId, workflowId, applyWorkflow]);

  const saveJson = () => {
    const wf = workflowRef.current;
    if (!wf || validationErrors.length > 0) return;
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${wf.id}.workflow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveWorkflow = async () => {
    const wf = workflowRef.current;
    if (!wf || !packageId || validationErrors.length > 0) return;
    setSaveBusy(true);
    setSaveMessage(undefined);
    setLoadError(undefined);
    try {
      await window.flowforge.saveWorkflow(packageId, wf);
      await onPackagesChanged();
      setSaveMessage(`Saved ${wf.id} to the installed package.`);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setSaveBusy(false);
    }
  };

  // ---- Live run overlay ----------------------------------------------------
  const { run: watchedRun, settled: watchSettled } = usePolledRun(watchTarget);
  const [visitedNodes, setVisitedNodes] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!watchTarget) {
      setVisitedNodes(new Set());
      return;
    }
    if (watchedRun && (watchedRun.status === 'completed' || watchedRun.status === 'failed')) {
      let cancelled = false;
      window.flowforge
        .getAuditTrail(watchedRun.id)
        .then((trail) => {
          if (cancelled) return;
          setVisitedNodes(
            new Set(trail.records.map((record) => record.nodeId).filter((id): id is string => Boolean(id)))
          );
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    setVisitedNodes(new Set());
  }, [watchTarget, watchedRun]);

  useEffect(() => {
    if (!watchTarget) return;
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        data: {
          ...node.data,
          current: watchedRun?.currentNodeId === node.id,
          pending: watchedRun?.pending?.nodeId === node.id,
          visited: visitedNodes.has(node.id)
        }
      }))
    );
  }, [watchTarget, watchedRun, visitedNodes]);

  useEffect(() => {
    setEdges((prev) =>
      prev.map((edge) => {
        const traversed = visitedNodes.has(edge.source) && visitedNodes.has(edge.target);
        return {
          ...edge,
          data: { ...edge.data, traversed },
          style: { ...(edge.style ?? {}), stroke: traversed ? '#22c55e' : edge.style?.stroke }
        };
      })
    );
  }, [visitedNodes]);

  // ---- Dry run -------------------------------------------------------------
  const handleStartDryRun = () => {
    const wf = workflowRef.current;
    if (!wf || validationErrors.length > 0) return;
    setDryRun(advanceDryRun(createDryRun(wf), wf));
  };

  const handleDryRunResponse = (response: HumanResponse) => {
    const wf = workflowRef.current;
    if (!wf || !dryRun) return;
    setDryRun(respondDryRun(dryRun, wf, response));
  };

  return (
    <div>
      <h1 className="ff-page-title">Workflow editor</h1>
      <p className="ff-page-sub">
        Visual editor over a loaded workflow. Edit the client-side JSON — no kernel writes.
      </p>

      <div className="ff-editor-toolbar">
        <select className="ff-select" value={packageId} onChange={(event) => setPackageId(event.target.value)}>
          {packages.length === 0 && <option value="">— no packages —</option>}
          {packages.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.branding?.displayName ?? pkg.name}
            </option>
          ))}
        </select>
        <select className="ff-select" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.id}
            </option>
          ))}
        </select>
        <select className="ff-select" value={newNodeType} onChange={(event) => setNewNodeType(event.target.value as WorkflowNodeType)}>
          {NODE_TYPES_OPTIONS.map((type) => (
            <option key={type} value={type}>
              + {type}
            </option>
          ))}
        </select>
        <button className="ff-btn" onClick={addNode} disabled={!workflow}>
          Add node
        </button>
        <button className="ff-btn" onClick={resetWorkflow} disabled={!workflow}>
          Reset
        </button>
        <button className="ff-btn primary" onClick={() => void saveWorkflow()} disabled={saveBusy || !workflow || validationErrors.length > 0}>
          Save workflow
        </button>
        <button className="ff-btn" onClick={saveJson} disabled={!workflow}>
          Export JSON
        </button>
        <span className={`ff-badge ${validationErrors.length === 0 ? 'green' : 'red'}`}>
          {validationErrors.length === 0 ? 'valid' : `${validationErrors.length} error${validationErrors.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <ErrorInline error={loadError} />
      {saveMessage && <p className="ff-muted">{saveMessage}</p>}

      {!workflow && !loadError && (
        <div className="ff-card">
          <div className="ff-card-body">
            <Empty>Select a package and workflow above to load it into the editor.</Empty>
          </div>
        </div>
      )}

      {workflow && (
        <div className="ff-editor-body">
          <div className="ff-editor-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodesDelete={onNodesDelete}
              onConnect={onConnect}
              nodesConnectable
              fitView
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>

          <div className="ff-side-panel">
            <h4>Node properties</h4>
            {selectedNode ? (
              <PropertyPanel
                node={selectedNode}
                workflow={workflow}
                onPatch={patchSelectedNode}
                onRename={renameSelectedNode}
                onDelete={() => deleteNode(selectedNode.id)}
                availableSkills={activePackage?.skills ?? []}
                agentSkills={selectedAgentSummary?.skills ?? []}
                onAgentSkillsChange={selectedNode.type === 'agent' ? (skills) => void handleAgentSkillsChange(skills) : undefined}
              />
            ) : (
              <Empty>Select a node to edit its properties, or drag between handles to add an edge.</Empty>
            )}
          </div>
        </div>
      )}

      {workflow && validationErrors.length > 0 && (
        <div className="ff-errors-panel">
          <h4>Validation</h4>
          <ul className="ff-inline-errors">
            {validationErrors.map((message) => (
              <li key={message}>• {message}</li>
            ))}
          </ul>
        </div>
      )}

      {workflow && (
        <section className="ff-section">
          <h3>Live run overlay</h3>
          <div className="ff-card">
            <div className="ff-card-body">
              <div className="ff-form-row">
                <label>Watch run</label>
                <input
                  className="ff-input wide"
                  value={watchInput}
                  onChange={(event) => setWatchInput(event.target.value)}
                  placeholder="Paste a run id to highlight its progress on the graph"
                />
                <button className="ff-btn" onClick={() => setWatchTarget(watchInput.trim() || undefined)}>
                  Watch
                </button>
                {watchTarget && (
                  <button className="ff-btn ghost" onClick={() => setWatchTarget(undefined)}>
                    Stop
                  </button>
                )}
              </div>
              {watchTarget && watchedRun && (
                <dl className="ff-kv">
                  <dt>Status</dt>
                  <dd>
                    <span className={`ff-status ${watchedRun.status}`}>{watchedRun.status}</span>
                  </dd>
                  <dt>Current node</dt>
                  <dd className="ff-monospace">{watchedRun.currentNodeId ?? '—'}</dd>
                  <dt>Pending</dt>
                  <dd>
                    {watchedRun.pending ? `${watchedRun.pending.kind} (${watchedRun.pending.role})` : '—'}
                  </dd>
                </dl>
              )}
              {watchTarget && !watchSettled && <Empty>Watching run {watchTarget}…</Empty>}
              {watchTarget && watchSettled && !watchedRun && (
                <Empty>Run {watchTarget} not found.</Empty>
              )}
            </div>
          </div>
        </section>
      )}

      {workflow && (
        <section className="ff-section">
          <h3>Dry run</h3>
          <div className="ff-card">
            <div className="ff-card-body">
              <div className="ff-btn-row" style={{ marginBottom: 10 }}>
                <button className="ff-btn primary" onClick={handleStartDryRun} disabled={validationErrors.length > 0}>
                  Dry run
                </button>
                <span className="ff-progress-note">
                  Interprets the edited workflow in the renderer with a mock agent result (score 80).
                </span>
              </div>
              {dryRun && (
                <>
                  <p>
                    Status: <span className={`ff-status ${dryRun.status}`}>{dryRun.status}</span>
                    {dryRun.currentNodeId && (
                      <>
                        {' '}· current node <span className="ff-monospace">{dryRun.currentNodeId}</span>
                      </>
                    )}
                  </p>
                  {dryRun.pending && (
                    <div style={{ marginBottom: 10 }}>
                      <TaskForm pending={dryRun.pending} onSubmit={handleDryRunResponse} />
                    </div>
                  )}
                  {dryRun.status === 'failed' && <div className="ff-failure-card"><pre>{dryRun.error}</pre></div>}
                  <h4 className="ff-muted" style={{ margin: '12px 0 6px', fontSize: 12.5 }}>Run log</h4>
                  <ul className="ff-dryrun-log">
                    {dryRun.steps.map((step, index) => (
                      <li key={`${step.nodeId}-${index}`}>
                        {index + 1}. <span className="ff-node-type">{step.type}</span>{' '}
                        <span className="ff-monospace">{step.nodeId}</span>
                        {step.detail ? ` — ${step.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                  <h4 className="ff-muted" style={{ margin: '12px 0 6px', fontSize: 12.5 }}>Final state</h4>
                  <pre className="ff-pre">{JSON.stringify(dryRun.state, null, 2)}</pre>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
