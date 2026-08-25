import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode } from './graph.js';

export function FlowNodeComponent({
  data,
  selected,
  onDelete
}: NodeProps<FlowNode> & { onDelete: (id: string) => void }) {
  const node = data.node;
  const classes = [
    'ff-flow-node',
    `ff-node-${node.type}`,
    data.current ? 'current' : '',
    data.visited ? 'visited' : '',
    selected ? 'selected' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {data.pending && <span className="ff-node-pulse" title="Pending human task" />}
      <button className="ff-node-delete nodrag" title="Delete node" onClick={() => onDelete(node.id)}>
        ✕
      </button>
      <div className="ff-node-title">{node.id}</div>
      <div className="ff-node-type">{node.type}</div>
      {node.type !== 'end' && node.type !== 'humanApproval' && (
        <Handle type="source" position={Position.Right} id="out" />
      )}
      {node.type === 'humanApproval' && (
        <>
          <Handle type="source" position={Position.Right} id="approve" style={{ top: '32%' }} />
          <Handle type="source" position={Position.Right} id="reject" style={{ top: '68%' }} />
        </>
      )}
      <Handle type="target" position={Position.Left} id="in" />
    </div>
  );
}
