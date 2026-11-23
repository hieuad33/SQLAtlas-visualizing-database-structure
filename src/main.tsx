import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { Connection, Viewport } from '@xyflow/react'
import { AlertTriangle, Check, Code2, Database, Download, FileUp, FolderOpen, GitBranch, GitFork, Layers3, LayoutGrid, Link2, List, ListFilter, LoaderCircle, Network, PanelLeft, PanelRight, Plus, Redo2, Save, Search, StickyNote, Table2, Undo2, X } from 'lucide-react'
import { demoProject } from './demo'
import { Diagram } from './Diagram'
import { ErrorMessage, ImportForm, Modal, NoteForm, PathForm, RelationForm, TableForm, TableVisibilityForm } from './Editors'
import type { RelationSeed } from './Editors'
import { clustersOf, graphIndex, relatedTables, shortestPath } from './graph'
import type { SearchItem } from './graph'
import { autoLayout, fallbackPosition } from './layout'
import { createProject, nameEqual, relationIssue, tableName } from './model'
import type { ForeignKey, Note, Point, Project, SchemaModel, Table, ViewMode, ViewState } from './model'
import { Explorer, Inspector, TableList } from './Panels'
import { download, fileStem, readProject } from './project'
import { exportProblems, exportSql } from './sql'
import '@xyflow/react/dist/style.css'
import './styles.css'

const modes = [
  { id: 'diagram', label: 'Sơ đồ', icon: Network },
  { id: 'clusters', label: 'Cụm quan hệ', icon: Layers3 },
  { id: 'neighbors', label: 'Lân cận', icon: GitFork },
  { id: 'list', label: 'Danh sách', icon: List },
] as const

type Dialog = { kind: 'import'; file?: File } | { kind: 'export' | 'path' | 'diagnostics' | 'visibility' }
  | { kind: 'table'; id?: string; column?: string } | { kind: 'delete-table'; id: string }
  | { kind: 'relation'; id?: string; seed?: RelationSeed } | { kind: 'note'; note?: Note; table?: string }
type Focus = { type: 'fit'; ids?: string[]; mode?: ViewMode } | { type: 'restore'; viewport: Viewport }

function Workspace() {
  const [project, setProject] = useState(demoProject)
  const [demo, setDemo] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState<{ before: Project[]; after: Project[] }>({ before: [], after: [] })
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [focus, setFocus] = useState<Focus | null>({ type: 'fit' })
  const [workspaceKey, setWorkspaceKey] = useState(0)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [importError, setImportError] = useState('')
  const [column, setColumn] = useState<string | null>(null)
  const [selectedRelation, setSelectedRelation] = useState<string | null>(null)
  const [tab, setTab] = useState<'structure' | 'relations'>('structure')
  const [path, setPath] = useState<ReturnType<typeof shortestPath>>(null)
  const [mobile, setMobile] = useState<'explorer' | 'inspector' | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const worker = useRef<Worker | null>(null)
  const layoutRequest = useRef(0)
  const latest = useRef(project)
  latest.current = project
  const flow = useReactFlow()

  const { model, view } = project
  const onlyTables = useMemo(() => view.onlyTables && new Set(view.onlyTables), [view.onlyTables])
  const explorerModel = useMemo(() => {
    if (!onlyTables) return model
    return { ...model, tables: model.tables.filter(table => onlyTables.has(table.id)),
      relations: model.relations.filter(relation => onlyTables.has(relation.source) && (!relation.target || onlyTables.has(relation.target))) }
  }, [model, onlyTables])
  const graph = useMemo(() => graphIndex(explorerModel), [explorerModel])
  const clusters = useMemo(() => clustersOf(explorerModel, graph), [explorerModel, graph])
  const tables = useMemo(() => new Map(model.tables.map(table => [table.id, table])), [model.tables])
  const schemas = useMemo(() => [...new Set(model.tables.map(table => table.schema))].sort(), [model.tables])
  const clusterColors = useMemo(() => new Map(clusters.flatMap((cluster, index) => cluster.tables.map(id => [id, index] as const))), [clusters])
  const filtered = useMemo(() => {
    let ids = view.mode === 'clusters' && view.cluster ? clusters.find(cluster => cluster.id === view.cluster)?.tables : undefined
    if (view.mode === 'neighbors' && view.selected && graph.has(view.selected)) ids = [...relatedTables(graph, view.selected, view.depth)]
    return new Set((ids ?? [...graph.keys()]).filter(id => view.schema === null || tables.get(id)?.schema === view.schema))
  }, [clusters, graph, tables, view.mode, view.cluster, view.selected, view.depth, view.schema])
  const selected = tables.get(view.selected ?? '')
  const columnCount = useMemo(() => model.tables.reduce((sum, table) => sum + table.columns.length, 0), [model.tables])
  const visibleRelations = useMemo(() => model.relations.filter(relation => filtered.has(relation.source) && relation.target && filtered.has(relation.target)).length, [model.relations, filtered])

  function updateView(patch: Partial<ViewState>) {
    setProject(current => ({ ...current, view: { ...current.view, ...patch } }))
  }

  function select(id: string, nextColumn: string | null = null, relation: string | null = null) {
    updateView({ selected: id })
    setColumn(nextColumn)
    setSelectedRelation(relation)
    setTab(relation ? 'relations' : 'structure')
  }

  function focusTable(id: string, nextColumn: string | null = null, relation: string | null = null, fromSearch = false) {
    const edge = relation ? model.relations.find(item => item.id === relation) : undefined
    const ids = [...new Set([id, ...(edge ? [edge.source] : []), ...(edge?.target ? [edge.target] : [])])].filter(item => graph.has(item))
    const leaveMode = (fromSearch && (view.mode === 'list' || view.mode === 'neighbors')) || ids.some(item => !filtered.has(item))
    select(id, nextColumn, relation)
    if (leaveMode) updateView({ mode: 'diagram', schema: null, cluster: null, ...(nextColumn ? { folded: false } : {}) })
    else if (nextColumn) updateView({ folded: false })
    if (ids.length && (view.mode !== 'list' || leaveMode)) setFocus({ type: 'fit', ids })
    if (fromSearch) setMobile(null)
  }

  function chooseResult(item: SearchItem) {
    focusTable(item.table, item.kind === 'column' ? item.id : null, item.kind === 'relation' ? item.id : null, true)
  }

  function chooseRelation(id: string, keepTable = false) {
    const edge = model.relations.find(item => item.id === id)
    if (!edge) return
    const table = keepTable && (selected?.id === edge.source || selected?.id === edge.target) ? selected.id : edge.source
    if (keepTable) focusTable(table, null, id)
    else select(table, null, id)
  }

  function changeMode(mode: ViewMode) {
    if (mode === view.mode) return
    setPath(null)
    updateView({ mode, ...(mode === 'clusters' ? { cluster: null } : {}), ...(mode === 'neighbors' && !view.selected ? { selected: explorerModel.tables[0]?.id ?? null } : {}) })
    if (mode !== 'list') setFocus({ type: 'fit', mode })
  }

  function showTables(ids: string[] | null) {
    const selected = ids && (!view.selected || !ids.includes(view.selected)) ? ids[0] ?? null : view.selected
    updateView({ onlyTables: ids, mode: view.mode === 'list' ? 'list' : 'diagram', selected, schema: null, cluster: null })
    setSelectedRelation(null)
    setColumn(null)
    setPath(null)
    setDirty(true)
    closeDialog()
    if (view.mode !== 'list') setFocus({ type: 'fit' })
  }

  function commit(next: Project) {
    setHistory(current => ({ before: [...current.before.slice(-39), project], after: [] }))
    setProject(next)
    setDirty(true)
    setPath(null)
  }

  function undo(redo = false) {
    const snapshot = (redo ? history.after : history.before).at(-1)
    if (!snapshot) return
    setHistory(redo ? { before: [...history.before, project], after: history.after.slice(0, -1) }
      : { before: history.before.slice(0, -1), after: [...history.after, project] })
    const ids = new Set(snapshot.model.tables.map(table => table.id))
    const inScope = view.onlyTables?.filter(id => ids.has(id))
    const selected = inScope?.length && (!snapshot.view.selected || !inScope.includes(snapshot.view.selected)) ? inScope[0] : snapshot.view.selected
    setProject({ ...snapshot, view: { ...view, selected, onlyTables: inScope?.length ? inScope : null } })
    setDirty(true)
    setPath(null)
    setColumn(null)
    setSelectedRelation(null)
  }

  function newProject(next: Project, fit: boolean) {
    layoutRequest.current++
    setLayoutBusy(false)
    setProject(next)
    setWorkspaceKey(key => key + 1)
    setDemo(false)
    setDirty(false)
    setHistory({ before: [], after: [] })
    setColumn(null)
    setSelectedRelation(null)
    setTab('structure')
    setPath(null)
    setMobile(null)
    setDialog(null)
    setFocus(fit ? { type: 'fit' } : { type: 'restore', viewport: next.view.viewport })
  }

  function closeDialog() {
    if (worker.current) {
      worker.current.terminate()
      worker.current = null
    }
    setBusy(false)
    setImportError('')
    setDialog(null)
  }

  function importSql(input: File | string, name: string) {
    if (busy) return
    const instance = new Worker(new URL('./sql.worker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    setBusy(true)
    setImportError('')

    function fail(message: string) {
      if (worker.current !== instance) return
      instance.terminate()
      worker.current = null
      setImportError(message)
      setBusy(false)
    }

    instance.onerror = () => fail('Trình duyệt không thể khởi động bộ đọc SQL.')
    instance.onmessage = async ({ data }: MessageEvent<{ model?: SchemaModel; error?: string }>) => {
      if (worker.current !== instance) return
      const loaded = data.model
      if (!loaded || !loaded.tables.length) return fail(data.error ?? loaded?.diagnostics[0]?.message ?? 'Không tìm thấy bảng. Hãy nhập SQL có lệnh CREATE TABLE.')
      if (dirty && !window.confirm('Dự án hiện tại có thay đổi chưa lưu. Bạn muốn thay thế bằng SQL vừa nhập?')) {
        instance.terminate(); worker.current = null; setBusy(false); return
      }
      const next = createProject(name, loaded)
      next.view.folded = loaded.tables.length > 80
      try { next.positions = await autoLayout(loaded, next.view.folded) } catch { /* The diagram uses grid positions if the worker is unavailable. */ }
      if (worker.current !== instance) return
      instance.terminate()
      worker.current = null
      setBusy(false)
      newProject(next, true)
      setToast({ text: `Đã nhập ${loaded.tables.length} bảng${loaded.diagnostics.length ? ` · ${loaded.diagnostics.length} thông báo` : ''}` })
    }
    instance.postMessage(input)
  }

  async function openProject(file: File) {
    try {
      const next = readProject(await file.text())
      if (dirty && !window.confirm('Dự án hiện tại có thay đổi chưa lưu. Bạn muốn mở file dự án đã chọn?')) return
      newProject(next, false)
      setToast({ text: `Đã mở dự án ${next.name}` })
    } catch (error) { setToast({ text: (error as Error).message, error: true }) }
  }

  function saveProject() {
    download(JSON.stringify(project, null, 2), `${fileStem(project.name)}.sqlviz.json`, 'application/json;charset=utf-8')
    setDirty(false)
    setToast({ text: 'Đã tải file dự án' })
  }

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!focus || !flow.viewportInitialized || (focus.type === 'fit' && focus.mode && focus.mode !== view.mode)) return
    if (view.mode === 'list') { setFocus(null); return }
    const timer = setTimeout(() => {
      if (focus.type === 'restore') void flow.setViewport(focus.viewport)
      else void flow.fitView({ nodes: focus.ids?.map(id => ({ id })), padding: focus.ids?.length === 1 ? 0.35 : 0.12, duration: 250, maxZoom: focus.ids?.length === 1 ? 1.35 : 1.18, includeHiddenNodes: true })
      setFocus(null)
    }, 80)
    return () => clearTimeout(timer)
  }, [focus, flow.viewportInitialized, view.mode])

  function openSearch() {
    setMobile('explorer')
    requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() })
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || dialog) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        openSearch()
      } else if (key === 's') {
        event.preventDefault()
        saveProject()
      } else if ((key === 'z' || key === 'y') && !(event.target instanceof HTMLElement && (event.target.closest('input,textarea,select') || event.target.isContentEditable))) {
        event.preventDefault()
        undo(key === 'y' || event.shiftKey)
      }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  })

  function changePosition(id: string, position: Point) {
    const note = project.notes.find(item => item.id === id)
    if (note) commit({ ...project, notes: project.notes.map(item => item.id === id ? { ...item, position } : item) })
    else commit({ ...project, positions: { ...project.positions, [id]: position } })
  }

  async function arrange() {
    if (layoutBusy || !filtered.size) return
    const job = ++layoutRequest.current
    setLayoutBusy(true)
    try {
      const scoped = filtered.size < model.tables.length
      const layoutModel = scoped ? { ...model, tables: model.tables.filter(table => filtered.has(table.id)),
        relations: model.relations.filter(relation => filtered.has(relation.source) && relation.target && filtered.has(relation.target)) } : model
      const arranged = await autoLayout(layoutModel, view.folded)
      if (job !== layoutRequest.current || latest.current.model !== model) return
      const current = latest.current
      if (scoped) {
        const origin = model.tables.reduce((bounds, table, index) => {
          if (!filtered.has(table.id)) return bounds
          const point = current.positions[table.id] ?? fallbackPosition(index)
          return { x: Math.min(bounds.x, point.x), y: Math.min(bounds.y, point.y) }
        }, { x: Infinity, y: Infinity })
        for (const point of Object.values(arranged)) { point.x += origin.x - 12; point.y += origin.y - 12 }
      }
      setHistory(previous => ({ before: [...previous.before.slice(-39), current], after: [] }))
      setProject({ ...current, positions: scoped ? { ...current.positions, ...arranged } : arranged })
      setDirty(true)
      setFocus({ type: 'fit' })
    } catch { setToast({ text: 'Không thể tự sắp xếp sơ đồ.', error: true }) }
    finally { if (job === layoutRequest.current) setLayoutBusy(false) }
  }

  function onConnect(connection: Connection) {
    setDialog({ kind: 'relation', seed: { source: connection.source, target: connection.target,
      from: connection.sourceHandle?.split(':')[0] === 'table' ? undefined : connection.sourceHandle?.split(':')[0],
      to: connection.targetHandle?.split(':')[0] === 'table' ? undefined : connection.targetHandle?.split(':')[0] } })
  }

  function saveTable(table: Table, confirm: boolean) {
    const original = tables.get(table.id)
    const removed = new Set(original?.columns.filter(column => !table.columns.some(item => item.id === column.id)).map(column => column.id))
    const renamed = original?.columns.filter(column => table.columns.some(item => item.id === column.id && !nameEqual(item.name, column.name))) ?? []
    if ((table.extras.length || table.columns.some(column => /\b(?:AS|CHECK)\s*\(/i.test(column.attributes))) && (removed.size || renamed.length)) {
      return 'Bảng có biểu thức hoặc ràng buộc SQL tùy chỉnh. Hãy sửa các định nghĩa đó trong SQL nguồn trước khi đổi tên hoặc xóa cột.'
    }
    const affected = model.relations.filter(relation => (relation.source === table.id && relation.columns.some(id => removed.has(id)))
      || (relation.target === table.id && relation.targetColumns.some(id => removed.has(id))))
    if (affected.length && !confirm) return `Thay đổi sẽ xóa ${affected.length} quan hệ: ${affected.map(edge => edge.name || 'khóa ngoại').join(', ')}.`
    const nextTables = original ? model.tables.map(item => item.id === table.id ? table : item) : [...model.tables, table]
    const nextRelations = model.relations.filter(item => !affected.includes(item)).map(relation => {
      const target = relation.target ? nextTables.find(item => item.id === relation.target) : nextTables.find(item => item.schema === relation.reference.schema && item.name === relation.reference.table)
      if (!target || (target.id !== table.id && relation.target)) return relation
      const targetColumns = relation.reference.columns.map((name, index) => relation.targetColumns[index] || target.columns.find(item => nameEqual(item.name, name))?.id || '')
      return { ...relation, target: target.id, targetColumns, reference: { schema: target.schema, table: target.name, columns: targetColumns.map((id, index) => target.columns.find(column => column.id === id)?.name ?? relation.reference.columns[index]) } }
    })
    const nextModel = { ...model, tables: nextTables, relations: nextRelations }
    for (const relation of nextRelations.filter(item => item.source === table.id || item.target === table.id)) {
      const before = model.relations.find(item => item.id === relation.id)!
      const issue = relationIssue(nextModel, relation)
      if (issue && !relationIssue(model, before)) return `${relation.name || 'Khóa ngoại'}: ${issue}`
    }
    const position = canvasCenter()
    const next = { ...project, model: nextModel, view: { ...view, selected: table.id,
      onlyTables: !original && view.onlyTables ? [...view.onlyTables, table.id] : view.onlyTables }, positions: original ? project.positions : { ...project.positions, [table.id]: position } }
    if (!original && (view.mode === 'clusters' || (view.schema !== null && view.schema !== table.schema))) next.view = { ...next.view, mode: 'diagram', schema: null, cluster: null }
    commit(next)
    setColumn(null)
    setSelectedRelation(null)
    setTab('structure')
    setDialog(null)
    if (!original) setFocus({ type: 'fit', ids: [table.id] })
    setToast({ text: original ? 'Đã cập nhật bảng' : 'Đã thêm bảng' })
    return null
  }

  function deleteTable(table: Table) {
    const position = project.positions[table.id] ?? fallbackPosition(model.tables.indexOf(table))
    const nextTables = model.tables.filter(item => item.id !== table.id)
    const nextNotes = project.notes.map(note => note.table !== table.id ? note : { ...note, table: null, position: { x: note.position.x + position.x, y: note.position.y + position.y } })
    const positions = { ...project.positions }
    delete positions[table.id]
    const inScope = view.onlyTables?.filter(id => id !== table.id)
    commit({ ...project, positions, model: { ...model, tables: nextTables, relations: model.relations.filter(edge => edge.source !== table.id && edge.target !== table.id) },
      notes: nextNotes, view: { ...view, selected: inScope?.[0] ?? nextTables[0]?.id ?? null, onlyTables: inScope?.length ? inScope : null } })
    setDialog(null)
    setColumn(null)
    setSelectedRelation(null)
    setTab('structure')
    setToast({ text: `Đã xóa bảng ${table.name}` })
  }

  function saveRelation(relation: ForeignKey) {
    const relations = model.relations.some(item => item.id === relation.id) ? model.relations.map(item => item.id === relation.id ? relation : item) : [...model.relations, relation]
    const showAll = view.mode === 'clusters' || view.mode === 'neighbors' || view.mode === 'list' || !filtered.has(relation.source) || (relation.target && !filtered.has(relation.target))
    const ids = [...new Set([relation.source, ...(relation.target ? [relation.target] : [])])].filter(id => graph.has(id))
    commit({ ...project, model: { ...model, relations }, view: { ...view, selected: ids[0] ?? view.selected, ...(showAll ? { mode: 'diagram', schema: null, cluster: null } : {}) } })
    setColumn(null)
    setSelectedRelation(relation.id)
    setTab('relations')
    if (ids.length) setFocus({ type: 'fit', ids })
    setDialog(null)
    setToast({ text: 'Đã lưu quan hệ' })
  }

  function deleteRelation(id: string) {
    commit({ ...project, model: { ...model, relations: model.relations.filter(relation => relation.id !== id) } })
    setSelectedRelation(null)
    setDialog(null)
    setToast({ text: 'Đã xóa quan hệ' })
  }

  function canvasCenter() {
    const box = canvas.current?.getBoundingClientRect()
    if (box && view.mode !== 'list') return flow.screenToFlowPosition({ x: box.x + box.width * 0.48, y: box.y + box.height * 0.43 })
    return fallbackPosition(model.tables.length)
  }

  function saveNote(note: Note) {
    const notes = project.notes.some(item => item.id === note.id) ? project.notes.map(item => item.id === note.id ? note : item) : [...project.notes, note]
    const hiddenOwner = onlyTables && note.table && !onlyTables.has(note.table) ? note.table : null
    const revealNote = !hiddenOwner && (view.mode === 'list' || (note.table ? !filtered.has(note.table) : view.mode !== 'diagram' || view.schema !== null))
    commit({ ...project, notes, view: revealNote ? { ...view, mode: 'diagram', schema: null, cluster: null } : view })
    if (revealNote) setFocus({ type: 'fit', ids: [note.id] })
    setDialog(null)
    setToast({ text: hiddenOwner ? 'Đã lưu chú thích cho bảng đang ẩn' : 'Đã lưu chú thích' })
  }

  function trace(from: string, to: string) {
    if (from === to) return 'Chọn hai bảng khác nhau.'
    const found = shortestPath(graph, from, to)
    if (!found) return 'Hai bảng không có đường liên kết qua khóa ngoại.'
    setPath(found)
    setColumn(null)
    setSelectedRelation(null)
    updateView({ mode: 'diagram', selected: from, schema: null, cluster: null })
    setFocus({ type: 'fit', ids: found.tables })
    setDialog(null)
    return null
  }

  function renderDialog() {
    if (!dialog) return null
    if (dialog.kind === 'import') return <Modal key="import" title="Nhập lược đồ SQL" subtitle="Tải file hoặc dán SQL từ MySQL / MariaDB." onClose={closeDialog}>
      <ImportForm initialFile={dialog.file} onImport={importSql} busy={busy} error={importError} />
    </Modal>
    if (dialog.kind === 'table') {
      const table = dialog.id ? tables.get(dialog.id) : undefined
      return <Modal key={`table-${dialog.id}`} title={table ? `Chỉnh sửa ${table.name}` : 'Thêm bảng'} width="wide" onClose={closeDialog}>
        <TableForm project={project} table={table} column={dialog.column} onSave={saveTable} onRemove={table ? () => setDialog({ kind: 'delete-table', id: table.id }) : undefined} />
      </Modal>
    }
    if (dialog.kind === 'delete-table') {
      const table = tables.get(dialog.id)!
      const affected = model.relations.filter(item => item.source === table.id || item.target === table.id)
      return <Modal key="delete" title={`Xóa bảng ${table.name}?`} onClose={closeDialog}>
        {affected.length > 0 && <p className="delete-description">Xóa bảng cũng sẽ xóa {affected.length} quan hệ: {affected.map(relation => relation.name || 'khóa ngoại').join(', ')}.</p>}
        <div className="modal-footer"><button className="button quiet" onClick={closeDialog}>Hủy</button><button className="button danger" onClick={() => deleteTable(table)}>Xóa bảng</button></div>
      </Modal>
    }
    if (dialog.kind === 'relation') {
      const relation = model.relations.find(item => item.id === dialog.id)
      return <Modal key={`relation-${dialog.id}`} title={relation ? 'Chỉnh sửa khóa ngoại' : 'Thêm quan hệ'} subtitle="Chọn cột nguồn và cột mà khóa ngoại tham chiếu đến." onClose={closeDialog}>
        <RelationForm project={project} relation={relation} seed={dialog.seed} onSave={saveRelation} onRemove={relation ? () => deleteRelation(relation.id) : undefined} />
      </Modal>
    }
    if (dialog.kind === 'visibility') return <Modal key="visibility" title="Chọn bảng hiển thị" subtitle="Sơ đồ sẽ chỉ hiện các bảng đã chọn và quan hệ giữa chúng." onClose={closeDialog}>
      <TableVisibilityForm project={project} onApply={showTables} />
    </Modal>
    if (dialog.kind === 'note') return <Modal key="note" title={dialog.note ? 'Chỉnh sửa chú thích' : 'Thêm chú thích'} onClose={closeDialog}>
      <NoteForm project={project} note={dialog.note} table={dialog.table} center={canvasCenter()} onSave={saveNote}
        onRemove={dialog.note ? () => { commit({ ...project, notes: project.notes.filter(item => item !== dialog.note) }); setDialog(null) } : undefined} />
    </Modal>
    if (dialog.kind === 'path') return <Modal key="path" title="Tìm đường liên kết" subtitle="Hiển thị đường đi ngắn nhất giữa hai bảng qua khóa ngoại." onClose={closeDialog}>
      <PathForm project={project} onPath={trace} onClear={() => { setPath(null); closeDialog() }} active={Boolean(path)} />
    </Modal>
    if (dialog.kind === 'diagnostics') return <Modal key="diagnostics" title="Thông báo nhập SQL" onClose={closeDialog}>
      <ul className="diagnostics">{model.diagnostics.map((issue, index) => <li key={index}><AlertTriangle size={15} /><span><strong>Dòng {issue.line}</strong> {issue.message}</span></li>)}</ul>
    </Modal>
    const problems = exportProblems(model)
    const sql = !problems.length && model.tables.length ? exportSql(model) : ''
    return <Modal key="export" title="Xuất lược đồ SQL" subtitle="Tạo bảng, chỉ mục và khóa ngoại trên cơ sở dữ liệu trống." width="wide" onClose={closeDialog}>
      {problems.length > 0 && <><ErrorMessage message="Hãy xử lý các lỗi dưới đây trước khi xuất SQL." /><ul className="diagnostics">{problems.map((problem, index) => <li key={index}><span>{problem}</span></li>)}</ul></>}
      {sql && <textarea className="sql-preview code-input" readOnly spellCheck={false} rows={15} aria-label="SQL xem trước" value={sql} />}
      {!sql && !problems.length && <ErrorMessage message="Cần có ít nhất một bảng để xuất SQL." />}
      <div className="modal-footer"><button className="button primary" disabled={!sql} onClick={() => { download(sql, `${fileStem(project.name)}.sql`, 'application/sql;charset=utf-8'); setToast({ text: 'Đã tải file SQL' }); closeDialog() }}><Download size={16} /> Tải file SQL</button></div>
    </Modal>
  }

  return <div className={`app${mobile ? ` mobile-${mobile}` : ''}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => {
    const file = event.dataTransfer.files[0]
    if (!file) return
    event.preventDefault()
    if (dialog) return
    if (/\.json$/i.test(file.name)) void openProject(file)
    else setDialog({ kind: 'import', file })
  }}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Layers3 size={22} strokeWidth={2.15} /></span><span>SQL<span className="brand-accent">Atlas</span></span></div>
      <div className="topbar-separator" />
      <span className="topbar-project"><Database size={15} /><span title={project.name}>{project.name}</span>{dirty && <i title="Có thay đổi chưa lưu" />}</span>
      <div className="topbar-actions">
        <input ref={openRef} type="file" accept=".sqlviz.json,.json" hidden onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void openProject(file)
        }} />
        <button className="button quiet top-action" onClick={() => openRef.current?.click()} title="Mở dự án"><FolderOpen size={16} /><span>Mở dự án</span></button>
        <button className="button outline top-action" onClick={saveProject} title="Lưu dự án"><Save size={16} /><span>Lưu dự án</span></button>
        <button className="button primary" onClick={() => setDialog({ kind: 'import' })}><FileUp size={17} /> Nhập SQL</button>
      </div>
    </header>

    <section className="workspace-heading" aria-label="Tổng quan lược đồ">
      <div className="heading-main"><div className="heading-path"><LayoutGrid size={13} /> Không gian làm việc <span>/</span> Lược đồ</div>
        <div className="heading-line"><h1>Sơ đồ cơ sở dữ liệu</h1>{demo && <span className="sample-tag">Dữ liệu mẫu</span>}</div>
      </div>
      <div className="heading-actions"><div className="metrics"><div><Table2 size={18} /><strong>{model.tables.length}</strong><span>Bảng</span></div><div><GitBranch size={18} /><strong>{model.relations.length}</strong><span>Quan hệ</span></div><div><Layers3 size={18} /><strong>{clusters.length}</strong><span>Cụm</span></div></div>
        <button className="button outline mobile-search" aria-label="Tìm kiếm" onClick={openSearch}><Search size={16} /><span>Tìm kiếm</span></button></div>
    </section>

    <main className="workbench">
      <Explorer key={workspaceKey} name={project.name} model={explorerModel} clusters={clusters} clusterMode={view.mode === 'clusters'} cluster={view.cluster} selected={view.selected} searchRef={searchRef}
        onTable={id => { focusTable(id); setMobile(null) }} onSearch={chooseResult} onCluster={id => { updateView({ cluster: id }); setFocus({ type: 'fit' }); setMobile(null) }} onAdd={() => setDialog({ kind: 'table' })} />

      <section className="board" aria-label="Bản đồ lược đồ">
        <div className="board-toolbar">
          <button className="icon-btn mobile-toggle" title="Hiện khám phá" aria-label="Hiện khám phá" onClick={() => setMobile(mobile === 'explorer' ? null : 'explorer')}><PanelLeft size={19} /></button>
          <div className="view-switch" aria-label="Chế độ xem">{modes.map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={view.mode === id} title={label} className={view.mode === id ? 'active' : ''} onClick={() => changeMode(id)}><Icon size={15} /><span>{label}</span></button>)}</div>
          <div className="board-actions">
            <button className="icon-btn" title="Tìm đường liên kết" aria-label="Tìm đường liên kết" disabled={graph.size < 2} onClick={() => setDialog({ kind: 'path' })}><GitFork size={17} /></button>
            <button className="icon-btn" title={selected ? `Thêm chú thích cho ${selected.name}` : 'Thêm chú thích'} aria-label="Thêm chú thích" onClick={() => setDialog({ kind: 'note', table: selected?.id })}><StickyNote size={17} /></button>
            <button className="icon-btn" title="Thêm quan hệ" aria-label="Thêm quan hệ" disabled={!tables.size} onClick={() => setDialog({ kind: 'relation' })}><Link2 size={17} /></button>
            <span className="tool-divider" />
            <button className="icon-btn" title="Xuất SQL" aria-label="Xuất SQL" onClick={() => setDialog({ kind: 'export' })}><Code2 size={19} /></button>
            <button className="icon-btn mobile-toggle" title="Hiện chi tiết" aria-label="Hiện chi tiết" onClick={() => setMobile(mobile === 'inspector' ? null : 'inspector')}><PanelRight size={19} /></button>
          </div>
        </div>
        <div className="canvas" ref={canvas}>
          {view.mode === 'list' ? <TableList selected={view.selected} tables={model.tables.filter(table => filtered.has(table.id))} onTable={id => select(id)} onEdit={id => setDialog({ kind: 'table', id })} />
            : <><Diagram key={workspaceKey} project={project} visible={filtered} colors={clusterColors} selected={view.selected} column={column} relation={selectedRelation} path={path} layoutBusy={layoutBusy}
              onSelect={select} onColumn={(id, columnId) => select(id, columnId)} onRelation={chooseRelation} onConnect={onConnect} onNote={note => setDialog({ kind: 'note', note })}
              onMove={changePosition} onViewport={viewport => updateView({ viewport })} onLayout={() => void arrange()} />
              {!filtered.size && <div className="canvas-empty"><Database size={28} /><strong>{model.tables.length ? 'Không có bảng trong bộ lọc này' : 'Lược đồ chưa có bảng'}</strong>
                {model.tables.length ? <button className="button outline" onClick={() => { updateView({ schema: null, cluster: null }); setFocus({ type: 'fit' }) }}>Xóa bộ lọc</button>
                  : <button className="button primary" onClick={() => setDialog({ kind: 'table' })}><Plus size={16} /> Thêm bảng</button>}</div>}
            </>}
          <div className="canvas-filters">
            <button className={`button canvas-option${onlyTables ? ' active' : ''}`} disabled={!tables.size} aria-label="Chọn bảng hiển thị" onClick={() => setDialog({ kind: 'visibility' })}><ListFilter size={15} />{onlyTables ? `${onlyTables.size} / ${tables.size} bảng` : 'Chọn bảng'}</button>
            {onlyTables && <button className="button canvas-option" onClick={() => showTables(null)} title="Hiện tất cả bảng" aria-label="Hiện tất cả bảng"><X size={14} /><span className="show-all-tables">Hiện tất cả</span></button>}
            {schemas.length > 1 && <select aria-label="Lọc theo database" value={view.schema ?? '*'} onChange={event => { updateView({ schema: event.target.value === '*' ? null : event.target.value }); if (view.mode !== 'list') setFocus({ type: 'fit' }) }}><option value="*">Tất cả database</option>{schemas.map(schema => <option key={schema} value={schema}>{schema || 'Mặc định'}</option>)}</select>}
            {view.mode === 'neighbors' && <select aria-label="Số bước quan hệ" value={view.depth} onChange={event => { updateView({ depth: Number(event.target.value) }); setFocus({ type: 'fit' }) }}>{[1, 2, 3].map(step => <option key={step} value={step}>{step} bước</option>)}</select>}
            {view.mode !== 'list' && <button className={`button canvas-option${view.folded ? ' active' : ''}`} aria-pressed={view.folded} onClick={() => updateView({ folded: !view.folded })}><Table2 size={14} />{view.folded ? 'Hiện cột' : 'Thu gọn cột'}</button>}
            {path && <button className="button canvas-option active" onClick={() => setPath(null)} title="Bỏ làm nổi bật đường liên kết">{path.relations.length} bước liên kết <X size={13} /></button>}
          </div>
          {layoutBusy && <div className="canvas-loading"><LoaderCircle size={17} className="spin" /> Đang sắp xếp…</div>}
        </div>
        <footer className="board-footer"><span><i /> {filtered.size} bảng <b>·</b> {visibleRelations} quan hệ</span>
          <div>{model.diagnostics.length > 0 && <button className="button quiet diagnostic-button" onClick={() => setDialog({ kind: 'diagnostics' })}><AlertTriangle size={15} /> {model.diagnostics.length} thông báo</button>}
            <button className="icon-btn" title="Hoàn tác" aria-label="Hoàn tác" disabled={!history.before.length} onClick={() => undo()}><Undo2 size={16} /></button>
            <button className="icon-btn" title="Làm lại" aria-label="Làm lại" disabled={!history.after.length} onClick={() => undo(true)}><Redo2 size={16} /></button></div>
        </footer>
      </section>

      <Inspector model={model} table={selected} selectedColumn={column} selectedRelation={selectedRelation} tab={tab} onTab={setTab}
        onEdit={(id, column) => setDialog({ kind: 'table', id, column })} onRelation={id => chooseRelation(id, true)} onEditRelation={id => setDialog({ kind: 'relation', id })}
        onAddRelation={() => setDialog({ kind: 'relation' })} onNote={table => setDialog({ kind: 'note', table })} />
    </main>
    <footer className="statusbar"><span><Database size={14} /> MySQL / MariaDB</span><span>{columnCount} cột</span><span className="status-local"><i /> Xử lý trên máy</span></footer>
    {toast && <div className={`toast${toast.error ? ' error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <AlertTriangle size={18} /> : <Check size={18} />}<span>{toast.text}</span><button className="icon-btn" aria-label="Đóng thông báo" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {renderDialog()}
  </div>
}

createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Workspace /></ReactFlowProvider>)
