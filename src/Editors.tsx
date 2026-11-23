import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, ArrowRight, Check, Code2, Database, FileCode2, FileUp, Link2, LoaderCircle, Plus, Search, StickyNote, Table2, Trash2, Upload, X } from 'lucide-react'
import { actions, nameEqual, newId, relationIssue, tableName } from './model'
import type { ForeignKey, ForeignKeyAction, Note, Project, Table } from './model'
import { parseColumnInput } from './sql'

export function Modal({ title, subtitle, width = 'normal', children, onClose }: { title: string; subtitle?: string; width?: 'normal' | 'wide'; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className={`modal ${width}`} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-inner">
      <div className="modal-header"><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="icon-btn" title="Đóng" aria-label="Đóng" onClick={onClose}><X size={20} /></button></div>
      {children}
    </div>
  </dialog>
}

export function ErrorMessage({ message }: { message: string }) {
  return message ? <div className="form-error" role="alert"><AlertCircle size={16} /><span>{message}</span></div> : null
}

export function ImportForm({ onImport, busy, error, initialFile }: { onImport: (input: File | string, name: string) => void; busy: boolean; error: string; initialFile?: File }) {
  const [tab, setTab] = useState<'file' | 'text'>('file')
  const [file, setFile] = useState<File | null>(initialFile ?? null)
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  return <form onSubmit={event => {
    event.preventDefault()
    const input = tab === 'file' ? file : text.trim()
    if (input) onImport(input, input instanceof File ? input.name.replace(/\.sql$/i, '') : 'Lược đồ mới')
  }}>
    <div className="dialog-tabs">
      <button type="button" className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}><FileUp size={16} /> Tải file SQL</button>
      <button type="button" className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><Code2 size={16} /> Dán SQL</button>
    </div>
    {tab === 'file' ? <>
      <input ref={picker} type="file" accept=".sql,text/plain,application/sql" hidden onChange={event => setFile(event.target.files?.[0] ?? null)} />
      <button type="button" disabled={busy} className={`file-drop${dragging ? ' dragging' : ''}`} onClick={() => picker.current?.click()}
        onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (!busy) setFile(event.dataTransfer.files[0] ?? null) }}>
        <span className="drop-icon">{file ? <FileCode2 size={25} /> : <Upload size={25} />}</span>
        <strong>{file?.name ?? 'Kéo file .sql vào đây hoặc bấm để chọn'}</strong>
        <span>{file ? `${(file.size / 1024).toLocaleString('vi', { maximumFractionDigits: 1 })} KB · Bấm để đổi file` : 'Hỗ trợ bản xuất từ MySQL và MariaDB'}</span>
      </button>
    </> : <label className="field">Nội dung SQL<textarea className="code-input" value={text} onChange={event => setText(event.target.value)} placeholder="CREATE TABLE …" rows={10} spellCheck={false} disabled={busy} /></label>}
    <ErrorMessage message={error} />
    <div className="modal-footer"><button className="button primary" disabled={busy || (tab === 'file' ? !file : !text.trim())}>
      {busy ? <LoaderCircle className="spin" size={16} /> : <Database size={16} />}{busy ? 'Đang đọc SQL…' : 'Tạo sơ đồ'}
    </button></div>
  </form>
}

type DraftColumn = Table['columns'][number] & { primary: boolean }

export function TableForm({ project, table, column, onSave, onRemove }: { project: Project; table?: Table; column?: string; onSave: (table: Table, confirm: boolean) => string | null; onRemove?: () => void }) {
  const [name, setName] = useState(table?.name ?? '')
  const [schema, setSchema] = useState(table?.schema ?? project.view.schema ?? '')
  const primary = table?.keys.find(key => key.kind === 'primary')
  const [columns, setColumns] = useState<DraftColumn[]>(() => table?.columns.map(column => ({ ...column, primary: primary?.columns.includes(column.id) ?? false }))
    ?? [{ id: newId(), name: 'id', type: 'BIGINT', attributes: 'NOT NULL', primary: true }])
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [tableId] = useState(() => table?.id ?? newId())
  const [primaryId] = useState(() => primary?.id ?? newId())

  function update(id: string, next: Partial<DraftColumn>) {
    setColumns(items => items.map(item => item.id === id ? { ...item, ...next } : item))
    setConfirm(false)
  }

  function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    const cleanName = name.trim()
    const cleanSchema = schema.trim()
    if (!cleanName || !columns.length || columns.some(column => !column.name.trim()) || /[\u0000-\u001f]/.test(cleanName + cleanSchema + columns.map(column => column.name).join(''))) return setError('Nhập tên bảng và ít nhất một cột có tên hợp lệ.')
    if (project.model.tables.some(other => other.id !== tableId && other.name === cleanName && other.schema === cleanSchema)) return setError('Tên bảng đã tồn tại trong database này.')
    if (columns.some((column, index) => columns.slice(0, index).some(other => nameEqual(column.name.trim(), other.name.trim())))) return setError('Tên cột phải khác nhau.')
    let parsed: Table['columns']
    try { parsed = columns.map(column => parseColumnInput(column.name.trim(), column.type.trim(), column.attributes.trim(), column.id)) }
    catch (failure) { return setError((failure as Error).message) }
    const ids = new Set(parsed.map(column => column.id))
    const selected = new Set(columns.filter(column => column.primary).map(column => column.id))
    const keyColumns = [...new Set([...(primary?.columns ?? []), ...selected])].filter(id => selected.has(id))
    const keys = [...(table?.keys.filter(key => key.kind !== 'primary' && key.columns.every(id => ids.has(id))) ?? [])]
    if (keyColumns.length) keys.unshift({ id: primaryId, kind: 'primary', columns: keyColumns, head: primary?.head ?? 'PRIMARY KEY', tails: keyColumns.map(id => primary?.tails[primary.columns.indexOf(id)] || ''), suffix: primary?.suffix ?? '' })
    const problem = onSave({ id: tableId, schema: cleanSchema, name: cleanName, columns: parsed, keys, extras: table?.extras ?? [], options: table?.options ?? '' }, confirm)
    if (problem) setError(problem)
    if (problem?.startsWith('Thay đổi sẽ xóa')) setConfirm(true)
  }

  return <form onSubmit={save}>
    <div className="form-grid"><label className="field">Tên bảng<input value={name} onChange={event => { setName(event.target.value); setConfirm(false) }} required maxLength={64} /></label>
      <label className="field">Database<input value={schema} onChange={event => { setSchema(event.target.value); setConfirm(false) }} maxLength={64} placeholder="Database hiện tại" /></label></div>
    <div className="editor-columns">
      <div className="editor-columns-label"><span>Tên cột</span><span>Kiểu dữ liệu</span><span>Thuộc tính SQL</span><span>PK</span><span /></div>
      {columns.map((item, index) => <div className="editor-column" key={item.id}>
        <input aria-label={`Tên cột ${index + 1}`} value={item.name} onChange={event => update(item.id, { name: event.target.value })} maxLength={64} autoFocus={item.id === column} required />
        <input aria-label={`Kiểu dữ liệu của ${item.name || `cột ${index + 1}`}`} value={item.type} onChange={event => update(item.id, { type: event.target.value })} required />
        <input aria-label={`Thuộc tính của ${item.name || `cột ${index + 1}`}`} value={item.attributes} placeholder="NULL, DEFAULT…" onChange={event => update(item.id, { attributes: event.target.value })} />
        <input type="checkbox" aria-label={`Khóa chính của ${item.name || `cột ${index + 1}`}`} checked={item.primary} onChange={event => update(item.id, { primary: event.target.checked })} />
        <button type="button" className="icon-btn danger-text" title="Xóa cột" aria-label={`Xóa cột ${item.name || index + 1}`} onClick={() => { setColumns(items => items.filter(item => item.id !== columns[index].id)); setConfirm(false) }}><Trash2 size={15} /></button>
      </div>)}
    </div>
    <button type="button" className="button quiet" onClick={() => { setColumns(items => [...items, { id: newId(), name: '', type: 'VARCHAR(255)', attributes: '', primary: false }]); setConfirm(false) }}><Plus size={15} /> Thêm cột</button>
    <ErrorMessage message={error} />
    <div className="modal-footer split">
      {onRemove ? <button type="button" className="button quiet danger-text" onClick={onRemove}><Trash2 size={16} /> Xóa bảng</button> : <span />}
      <button className="button primary"><Check size={16} />{confirm ? 'Xác nhận và lưu bảng' : 'Lưu bảng'}</button>
    </div>
  </form>
}

export interface RelationSeed { source?: string; target?: string; from?: string; to?: string }

export function RelationForm({ project, relation, seed, onSave, onRemove }: { project: Project; relation?: ForeignKey; seed?: RelationSeed; onSave: (relation: ForeignKey) => void; onRemove?: () => void }) {
  const [sourceId, setSource] = useState(relation?.source ?? seed?.source ?? project.view.selected ?? project.model.tables[0]?.id ?? '')
  const [targetId, setTarget] = useState(relation?.target ?? seed?.target ?? '')
  const [name, setName] = useState(relation?.name ?? '')
  const [pairs, setPairs] = useState(() => relation?.columns.map((from, index) => ({ from, to: relation.targetColumns[index] || '', key: newId() }))
    ?? [{ from: seed?.from ?? '', to: seed?.to ?? '', key: newId() }])
  const [onDelete, setOnDelete] = useState<ForeignKeyAction | ''>(relation?.onDelete ?? '')
  const [onUpdate, setOnUpdate] = useState<ForeignKeyAction | ''>(relation?.onUpdate ?? '')
  const [error, setError] = useState('')
  const [id] = useState(() => relation?.id ?? newId())
  const tables = project.model.tables.toSorted((a, b) => tableName(a).localeCompare(tableName(b)))
  const source = tables.find(table => table.id === sourceId)
  const target = tables.find(table => table.id === targetId)
  const options = tables.map(table => <option key={table.id} value={table.id}>{tableName(table)}</option>)

  function save(event: FormEvent) {
    event.preventDefault()
    if (!source || !target || pairs.some(pair => !pair.from || !pair.to)) return setError('Chọn đủ bảng và các cặp cột tham chiếu.')
    const cleanName = name.trim()
    if (/[\u0000-\u001f]/.test(cleanName)) return setError('Tên khóa ngoại chứa ký tự không hợp lệ.')
    const next: ForeignKey = { id, name: cleanName, source: source.id, target: target.id, columns: pairs.map(pair => pair.from), targetColumns: pairs.map(pair => pair.to),
      reference: { schema: target.schema, table: target.name, columns: pairs.map(pair => target.columns.find(column => column.id === pair.to)!.name) }, onDelete, onUpdate, match: relation?.match }
    const problem = relationIssue(project.model, next, true)
    if (problem) return setError(problem)
    onSave(next)
  }

  return <form onSubmit={save}>
    {relation && !relation.target && <ErrorMessage message={`Chưa tìm thấy bảng tham chiếu ${relation.reference.table}. Chọn bảng đích để sửa quan hệ.`} />}
    <label className="field relation-name">Tên khóa ngoại<input value={name} onChange={event => setName(event.target.value)} placeholder="Để trống để MySQL tự đặt tên" maxLength={64} /></label>
    <div className="relation-pair table-pair">
      <label className="field">Bảng nguồn<select value={sourceId} required onChange={event => { setSource(event.target.value); setPairs(old => old.map(pair => ({ ...pair, from: '' }))) }}><option value="">Chọn bảng</option>{options}</select></label>
      <ArrowRight size={16} aria-hidden="true" />
      <label className="field">Bảng đích<select value={targetId} required onChange={event => { setTarget(event.target.value); setPairs(old => old.map(pair => ({ ...pair, to: '' }))) }}><option value="">Chọn bảng</option>{options}</select></label><span />
    </div>
    <div className="column-pairs">{pairs.map((pair, index) => <div className="relation-pair" key={pair.key}>
      <select aria-label={`Cột nguồn ${index + 1}`} value={pair.from} required onChange={event => setPairs(old => old.map((item, i) => i === index ? { ...item, from: event.target.value } : item))}><option value="">Cột nguồn</option>{source?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
      <ArrowRight size={16} aria-hidden="true" />
      <select aria-label={`Cột đích ${index + 1}`} value={pair.to} required onChange={event => setPairs(old => old.map((item, i) => i === index ? { ...item, to: event.target.value } : item))}><option value="">Cột đích</option>{target?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
      <button className="icon-btn danger-text" type="button" disabled={pairs.length <= 1} aria-label={`Xóa cặp cột ${index + 1}`} onClick={() => setPairs(old => old.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
    </div>)}</div>
    <button className="button quiet" type="button" onClick={() => setPairs(old => [...old, { from: '', to: '', key: newId() }])}><Plus size={15} /> Thêm cặp cột</button>
    <div className="form-grid relation-actions">
      <label className="field">Khi xóa (ON DELETE)<select value={onDelete} onChange={event => setOnDelete(event.target.value as ForeignKeyAction | '')}><option value="">Mặc định</option>{actions.filter(item => item !== 'SET DEFAULT' || onDelete === item).map(item => <option key={item}>{item}</option>)}</select></label>
      <label className="field">Khi cập nhật (ON UPDATE)<select value={onUpdate} onChange={event => setOnUpdate(event.target.value as ForeignKeyAction | '')}><option value="">Mặc định</option>{actions.filter(item => item !== 'SET DEFAULT' || onUpdate === item).map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    <ErrorMessage message={error} />
    <div className="modal-footer split">{onRemove ? <button type="button" className="button quiet danger-text" onClick={onRemove}><Trash2 size={16} /> Xóa quan hệ</button> : <span />}
      <button className="button primary"><Link2 size={16} /> Lưu quan hệ</button></div>
  </form>
}

export function NoteForm({ project, note, center, table, onSave, onRemove }: { project: Project; note?: Note; center: { x: number; y: number }; table?: string; onSave: (note: Note) => void; onRemove?: () => void }) {
  const [text, setText] = useState(note?.text ?? '')
  const [target, setTarget] = useState(note?.table ?? table ?? '')
  return <form onSubmit={event => {
    event.preventDefault()
    if (!text.trim()) return
    const attached = target || null
    const position = note && note.table === attached ? note.position : attached ? { x: 30, y: -96 } : center
    onSave({ id: note?.id ?? newId(), table: attached, text: text.trim(), position })
  }}>
    <label className="field">Nội dung<textarea rows={4} required value={text} maxLength={2000} onChange={event => setText(event.target.value)} placeholder="Viết chú thích cho sơ đồ…" /></label>
    <label className="field note-target">Vị trí<select value={target} onChange={event => setTarget(event.target.value)}><option value="">Tự do trên sơ đồ</option>
      {project.model.tables.map(table => <option key={table.id} value={table.id}>{tableName(table)}</option>)}</select></label>
    <div className="modal-footer split">{onRemove ? <button type="button" className="button quiet danger-text" onClick={onRemove}><Trash2 size={16} /> Xóa chú thích</button> : <span />}
      <button className="button primary" disabled={!text.trim()}><StickyNote size={16} /> Lưu chú thích</button></div>
  </form>
}

export function PathForm({ project, onPath, onClear, active }: { project: Project; onPath: (from: string, to: string) => string | null; onClear: () => void; active: boolean }) {
  const [from, setFrom] = useState(project.view.selected ?? '')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const only = project.view.onlyTables ? new Set(project.view.onlyTables) : null
  const options = project.model.tables.filter(table => !only || only.has(table.id)).toSorted((a, b) => tableName(a).localeCompare(tableName(b))).map(table => <option key={table.id} value={table.id}>{tableName(table)}</option>)
  return <form onSubmit={event => { event.preventDefault(); setError(onPath(from, to) ?? '') }}>
    <div className="form-grid"><label className="field">Bảng bắt đầu<select required value={from} onChange={event => setFrom(event.target.value)}><option value="">Chọn bảng</option>{options}</select></label>
      <label className="field">Bảng kết thúc<select required value={to} onChange={event => setTo(event.target.value)}><option value="">Chọn bảng</option>{options}</select></label></div>
    <ErrorMessage message={error} />
    <div className="modal-footer split">{active ? <button type="button" className="button quiet" onClick={onClear}>Bỏ làm nổi bật</button> : <span />}
      <button className="button primary"><Table2 size={16} /> Tìm đường</button></div>
  </form>
}

export function TableVisibilityForm({ project, onApply }: { project: Project; onApply: (ids: string[] | null) => void }) {
  const tables = project.model.tables
  const [selected, setSelected] = useState(() => new Set(project.view.onlyTables ?? tables.map(table => table.id)))
  const [query, setQuery] = useState('')
  const visible = tables.filter(table => tableName(table).toLowerCase().includes(query.trim().toLowerCase()))
    .toSorted((left, right) => tableName(left).localeCompare(tableName(right)))

  return <form onSubmit={event => {
    event.preventDefault()
    if (selected.size) onApply(selected.size === tables.length ? null : tables.filter(table => selected.has(table.id)).map(table => table.id))
  }}>
    <label className="search-box visibility-search"><Search size={17} /><input aria-label="Tìm bảng để chọn" placeholder="Tìm tên bảng hoặc database…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="visibility-actions"><span>{selected.size} / {tables.length} bảng được chọn</span>
      <button type="button" className="button quiet" onClick={() => setSelected(new Set(tables.map(table => table.id)))}>Chọn tất cả</button>
      <button type="button" className="button quiet" onClick={() => setSelected(new Set())}>Bỏ chọn</button></div>
    <div className="visibility-list">
      {visible.map(table => <label className="visibility-row" key={table.id}>
        <input type="checkbox" checked={selected.has(table.id)} onChange={event => {
          const checked = event.target.checked
          setSelected(previous => {
            const next = new Set(previous)
            if (checked) next.add(table.id); else next.delete(table.id)
            return next
          })
        }} /><Table2 size={15} /><span>{tableName(table)}</span><small>{table.columns.length} cột</small>
      </label>)}
      {!visible.length && <p className="rail-empty">Không tìm thấy bảng.</p>}
    </div>
    <div className="modal-footer"><button className="button primary" disabled={!selected.size}><Check size={16} /> Hiển thị các bảng đã chọn</button></div>
  </form>
}
