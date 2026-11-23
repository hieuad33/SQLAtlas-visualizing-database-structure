import { createContext, Fragment, memo, useContext, useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, BaseEdge, getSmoothStepPath, Handle, MarkerType, MiniMap, Position, ReactFlow, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import type { Connection, Edge, EdgeProps, Node, NodeChange, NodeProps, Viewport } from '@xyflow/react'
import { Focus, KeyRound, Link2, Maximize, Minus, Plus, StickyNote, Table2 } from 'lucide-react'
import { fallbackPosition, nodeHeight, nodeWidth } from './layout'
import { minimumZoom } from './model'
import type { ForeignKey, Note, Point, Project, Table } from './model'

type TableNode = Node<{ table: Table; folded: boolean; column: string | null; path: boolean; color: string }, 'table'>
type NoteNode = Node<{ note: Note }, 'note'>
type CanvasNode = TableNode | NoteNode
type CanvasEdge = Edge<{ self: boolean; offset: number }, 'relation'>

function Ports({ column, hidden }: { column: string; hidden?: boolean }) {
  return <>{(['left', 'right'] as const).map(side => <Fragment key={side}>
    <Handle id={`${column}:${side}:in`} type="target" position={side === 'left' ? Position.Left : Position.Right} isConnectableStart={false} className={hidden ? 'port hidden-port' : 'port'} />
    <Handle id={`${column}:${side}:out`} type="source" position={side === 'left' ? Position.Left : Position.Right} isConnectableEnd={false} className={hidden ? 'port hidden-port' : 'port'} />
  </Fragment>)}</>
}

const TableCard = memo(function TableCard({ id, data, selected }: NodeProps<TableNode>) {
  const { table, folded, column, path, color } = data
  const update = useUpdateNodeInternals()
  useEffect(() => { update(id) }, [id, folded, table.columns, update])
  const primary = new Set(table.keys.filter(key => key.kind === 'primary').flatMap(key => key.columns))
  const foreign = useForeignColumns(table.id)
  return <div className={`table-card${selected ? ' selected' : ''}${path ? ' path' : ''}`} style={{ '--node-accent': color } as React.CSSProperties}>
    <div className="node-header" data-drag-handle>
      <Ports column="table" hidden={!folded} />
      <Table2 size={15} /><span title={table.name}>{table.name}</span><small>{table.columns.length}</small>
    </div>
    {!folded && <div className="node-columns">{table.columns.map(item => <div key={item.id} data-column={item.id} className={`node-column${column === item.id ? ' marked' : ''}`}>
      <Ports column={item.id} />
      <span className="column-key">{primary.has(item.id) ? <KeyRound className="key-primary" size={12} /> : foreign.has(item.id) ? <Link2 className="key-foreign" size={12} /> : <i />}</span>
      <span className="node-column-name" title={item.name}>{item.name}</span><code title={item.type}>{shortType(item.type)}</code>
    </div>)}</div>}
  </div>
})

const ForeignColumns = createContext(new Map<string, Set<string>>())
const emptyColumns = new Set<string>()
const useForeignColumns = (id: string) => useContext(ForeignColumns).get(id) ?? emptyColumns

export function shortType(type: string) {
  return type.toLowerCase().replace(/\s+unsigned$/, '').replace(/\s*,\s*/g, ',')
}

const NoteCard = memo(function NoteCard({ data }: NodeProps<NoteNode>) {
  return <div className="note-card"><StickyNote size={15} /><p>{data.note.text}</p></div>
})

function RelationEdge(props: EdgeProps<CanvasEdge>) {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data } = props
  const bend = data?.offset ?? 0
  const [defaultPath] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10, offset: 20 + bend })
  const loop = `M ${sourceX} ${sourceY} C ${sourceX + 57 + bend} ${sourceY + 40}, ${targetX + 57 + bend} ${targetY - 40}, ${targetX} ${targetY}`
  return <BaseEdge id={props.id} path={data?.self ? loop : defaultPath} markerEnd={markerEnd} style={style} interactionWidth={18} />
}

const nodeTypes = { table: TableCard, note: NoteCard }
const edgeTypes = { relation: RelationEdge }
const palette = ['#9e8bff', '#51cdb1', '#6aabfc', '#eaa377', '#dd8fca']

interface DiagramProps {
  project: Project
  visible: Set<string>
  colors: Map<string, number>
  selected: string | null
  column: string | null
  relation: string | null
  path: { tables: string[]; relations: string[] } | null
  layoutBusy: boolean
  onSelect: (table: string) => void
  onColumn: (table: string, column: string) => void
  onRelation: (id: string) => void
  onConnect: (connection: Connection) => void
  onNote: (note: Note) => void
  onMove: (id: string, position: Point) => void
  onViewport: (viewport: Viewport) => void
  onLayout: () => void
}

export function Diagram(props: DiagramProps) {
  const { project, visible, colors, selected, column, relation, path } = props
  const { fitView, zoomIn, zoomOut } = useReactFlow<CanvasNode, CanvasEdge>()
  const [dragging, setDragging] = useState<Record<string, Point>>({})
  const [connecting, setConnecting] = useState(false)
  const tables = useMemo(() => new Map(project.model.tables.map((table, index) => [table.id, { table, position: dragging[table.id] ?? project.positions[table.id] ?? fallbackPosition(index) }])), [dragging, project.model.tables, project.positions])
  const setColors = useMemo(() => {
    const entries = new Map<string, Set<string>>()
    for (const relation of project.model.relations) {
      if (!entries.has(relation.source)) entries.set(relation.source, new Set())
      for (const id of relation.columns) entries.get(relation.source)!.add(id)
    }
    return entries
  }, [project.model.relations])
  const nodes = useMemo(() => {
    const result: CanvasNode[] = []
    for (const id of visible) {
      const entry = tables.get(id)
      if (!entry) continue
      const { table, position } = entry
      result.push({ id, type: 'table', width: nodeWidth, height: nodeHeight(table.columns.length, project.view.folded), position, selected: selected === id,
        data: { table, folded: project.view.folded, color: palette[(colors.get(id) ?? 0) % palette.length], column: selected === id ? column : null, path: path?.tables.includes(id) ?? false },
        ariaLabel: `Bảng ${table.name}` })
    }
    for (const note of project.notes) {
      if (note.table && !visible.has(note.table)) continue
      if (!note.table && (project.view.mode !== 'diagram' || project.view.schema !== null)) continue
      const owner = note.table ? tables.get(note.table)?.position : undefined
      const position = dragging[note.id] ?? (owner ? { x: owner.x + note.position.x, y: owner.y + note.position.y } : note.position)
      result.push({ id: note.id, type: 'note', position, data: { note }, connectable: false, ariaLabel: 'Chú thích', initialWidth: 215, initialHeight: 62 })
    }
    return result
  }, [visible, tables, dragging, project.view.folded, project.view.mode, project.view.schema, project.notes, selected, colors, column, path])
  const edges: CanvasEdge[] = useMemo(() => {
    const result: CanvasEdge[] = []
    const parallel = new Map<string, number>()
    for (const edge of project.model.relations) {
      if (!edge.target || !visible.has(edge.source) || !visible.has(edge.target)) continue
      const from = tables.get(edge.source)!
      const to = tables.get(edge.target)!
      const self = edge.source === edge.target
      const forward = from.position.x <= to.position.x
      const stacked = Math.abs(from.position.x - to.position.x) < nodeWidth * 0.8
      const fromSide = stacked || forward ? 'right' : 'left'
      const toSide = stacked || !forward ? 'right' : 'left'
      const key = [edge.source, edge.target].sort().join('/')
      const offset = (parallel.get(key) ?? 0) * 7
      parallel.set(key, (parallel.get(key) ?? 0) + 1)
      const active = relation === edge.id || (path?.relations.includes(edge.id) ?? false)
      const connected = selected === edge.source || selected === edge.target
      const color = active ? '#c3b4ff' : connected ? '#9e84f7' : '#687290'
      const sourceColumn = project.view.folded ? 'table' : edge.columns[0] ?? 'table'
      const targetColumn = project.view.folded ? 'table' : edge.targetColumns[0] || 'table'
      result.push({ id: edge.id, type: 'relation', source: edge.source, target: edge.target, sourceHandle: `${sourceColumn}:${fromSide}:out`, targetHandle: `${targetColumn}:${toSide}:in`,
        data: { self, offset }, style: { stroke: color, strokeWidth: active ? 2.8 : 1.5, opacity: path && !active ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color }, ariaLabel: edge.name || 'Khóa ngoại' })
    }
    return result
  }, [project.model.relations, project.view.folded, visible, tables, selected, relation, path])

  function dragStop(id: string, position: Point) {
    const table = project.notes.find(note => note.id === id)?.table
    const owner = table ? tables.get(table)?.position : undefined
    props.onMove(id, owner ? { x: position.x - owner.x, y: position.y - owner.y } : position)
  }

  function nodeChanges(changes: NodeChange<CanvasNode>[]) {
    const positions = changes.filter(change => change.type === 'position')
    if (!positions.length) return
    setDragging(current => {
      const next = { ...current }
      for (const change of positions) {
        if (change.dragging && change.position) next[change.id] = change.position
        else delete next[change.id]
      }
      return next
    })
  }

  function dragTableColumn(event: React.MouseEvent, item: CanvasNode) {
    if (item.type === 'note') {
      props.onNote(item.data.note)
      return
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-column]')
    if (target?.dataset.column) props.onColumn(item.id, target.dataset.column)
    else props.onSelect(item.id)
  }

  return <ForeignColumns.Provider value={setColors}>
    <ReactFlow<CanvasNode, CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} className={connecting ? 'is-connecting' : undefined}
      defaultViewport={project.view.viewport} minZoom={minimumZoom} maxZoom={3} onlyRenderVisibleElements={nodes.length > 80}
      nodesDraggable nodesConnectable elementsSelectable={false} edgesReconnectable={false} deleteKeyCode={null}
      isValidConnection={connection => !('id' in connection) && !!connection.targetHandle?.endsWith(':in')}
      onNodeClick={dragTableColumn} onEdgeClick={(_, edge) => props.onRelation(edge.id)} onConnect={props.onConnect}
      onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
      onNodesChange={nodeChanges} onNodeDragStop={(_, node) => dragStop(node.id, node.position)} onMoveEnd={(_, viewport) => props.onViewport(viewport)}
      proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="#34394a" />
      {nodes.length > 0 && <MiniMap pannable zoomable nodeColor={node => node.type === 'note' ? '#87754a' : node.id === selected ? '#9e8bff' : '#4f5778'} nodeBorderRadius={6} position="bottom-right" ariaLabel="Bản đồ thu nhỏ" />}
    </ReactFlow>
    <div className="canvas-tools" aria-label="Điều khiển sơ đồ">
      <button className="icon-btn" title="Thu nhỏ" aria-label="Thu nhỏ" onClick={() => void zoomOut({ duration: 180 })}><Minus size={16} /></button>
      <span className="zoom-value">{project.view.viewport.zoom < 0.01 ? '<1%' : `${Math.round(project.view.viewport.zoom * 100)}%`}</span>
      <button className="icon-btn" title="Phóng to" aria-label="Phóng to" onClick={() => void zoomIn({ duration: 180 })}><Plus size={16} /></button>
      <span className="tool-divider" />
      <button className="icon-btn" title="Vừa khung nhìn" aria-label="Vừa khung nhìn" onClick={() => void fitView({ padding: 0.13, duration: 260, maxZoom: 1.2, includeHiddenNodes: true })}><Maximize size={15} /></button>
      <button className="icon-btn" title="Tự sắp xếp" aria-label="Tự sắp xếp" disabled={props.layoutBusy} onClick={props.onLayout}><Focus size={17} /></button>
    </div>
  </ForeignColumns.Provider>
}

export function relationColumns(table: Table, relation: ForeignKey, target = false) {
  const columns = target ? relation.targetColumns : relation.columns
  return columns.map(id => table.columns.find(column => column.id === id)?.name ?? '…').join(', ')
}
