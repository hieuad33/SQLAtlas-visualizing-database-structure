import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Columns3, Database, KeyRound, Link2, Pencil, Plus, Search, Table2, UnfoldVertical, X } from 'lucide-react'
import { search, searchIndex } from './graph'
import type { Cluster, SearchItem } from './graph'
import { relationColumns } from './Diagram'
import { isNullable, tableName } from './model'
import type { ForeignKey, SchemaModel, Table } from './model'

function normalized(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd')
}

function Highlight({ value, query }: { value: string; query: string }) {
  const original = Array.from(value)
  const normalizedValue = original.map(normalized).join('')
  const terms = normalized(query.trim()).split(/\s+/).filter(Boolean)
  const matches = new Set<number>()
  for (const term of terms) {
    for (let index = normalizedValue.indexOf(term); index >= 0; index = normalizedValue.indexOf(term, index + term.length)) {
      for (let position = index; position < index + term.length; position++) matches.add(position)
    }
  }
  if (!matches.size) return <>{value}</>
  let cursor = 0
  return <>{original.map((character, index) => {
    const match = matches.has(cursor)
    cursor += normalized(character).length
    return match ? <mark key={index}>{character}</mark> : character
  })}</>
}

const resultIcons = { table: Table2, column: Columns3, relation: Link2 }
const resultNames = { table: 'Bảng', column: 'Cột', relation: 'Khóa ngoại' }

interface ExplorerProps {
  name: string
  model: SchemaModel
  clusters: Cluster[]
  clusterMode: boolean
  cluster: string | null
  selected: string | null
  searchRef: RefObject<HTMLInputElement | null>
  onTable: (id: string) => void
  onSearch: (result: SearchItem) => void
  onCluster: (id: string | null) => void
  onAdd: () => void
}

export function Explorer({ name, model, clusters, clusterMode, cluster, selected, searchRef, onTable, onSearch, onCluster, onAdd }: ExplorerProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [openGroups, setOpenGroups] = useState<Set<string> | null>(null)
  const index = useMemo(() => searchIndex(model), [model])
  const results = useMemo(() => search(index, query), [index, query])
  const tableById = useMemo(() => new Map(model.tables.map(table => [table.id, table])), [model.tables])
  const groups = useMemo(() => {
    const result = new Map<string, Table[]>()
    for (const table of model.tables) {
      if (!result.has(table.schema)) result.set(table.schema, [])
      result.get(table.schema)!.push(table)
    }
    return [...result].map(([schema, tables]) => [schema, tables.toSorted((a, b) => a.name.localeCompare(b.name))] as const)
  }, [model.tables])
  useEffect(() => {
    if (!query || !results[cursor]) return
    document.getElementById(`result-${cursor}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, query, results])

  function pick(result: SearchItem) {
    onSearch(result)
  }

  function row(table: Table) {
    return <button className={`tree-row${table.id === selected ? ' active' : ''}`} key={table.id} onClick={() => onTable(table.id)}>
      <Table2 size={15} /><span title={tableName(table)}>{table.name}</span><small>{table.columns.length}</small>
    </button>
  }

  return <aside className="explorer" aria-label="Khám phá lược đồ">
    <div className="rail-top">
      <div className="rail-title"><h2>Khám phá</h2><button className="icon-btn" title="Thêm bảng" aria-label="Thêm bảng" onClick={onAdd}><Plus size={17} /></button></div>
      <div className="search-box"><Search size={17} />
        <input ref={searchRef} aria-label="Tìm bảng, cột, khóa ngoại" placeholder="Tìm kiếm lược đồ…" value={query} onChange={event => { setQuery(event.target.value); setCursor(0) }}
          onKeyDown={event => {
            if (event.key === 'Escape') { setQuery(''); setCursor(0) }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor(old => Math.max(0, Math.min(results.length - 1, old + (event.key === 'ArrowDown' ? 1 : -1))))
            }
            if (event.key === 'Enter' && results[cursor]) { event.preventDefault(); pick(results[cursor]) }
          }} />
        {query ? <button className="icon-btn" title="Xóa tìm kiếm" aria-label="Xóa tìm kiếm" onClick={() => { setQuery(''); setCursor(0); searchRef.current?.focus() }}><X size={14} /></button> : <kbd>Ctrl K</kbd>}
      </div>
    </div>
    <div className="rail-tree">
      {query.trim() ? <>
        <div className="rail-caption">Kết quả tìm kiếm <span>{results.length}</span></div>
        {results.length ? results.map((result, index) => {
          const Icon = resultIcons[result.kind]
          return <button key={`${result.kind}-${result.id}`} id={`result-${index}`} className={`result-row${cursor === index ? ' current' : ''}`} onClick={() => { setCursor(index); pick(result) }}>
            <Icon size={16} /><span><strong><Highlight value={result.name} query={query} /></strong><small><Highlight value={result.detail} query={query} /></small></span><em>{resultNames[result.kind]}</em>
          </button>
        }) : <p className="rail-empty">Không tìm thấy kết quả cho “{query}”.</p>}
      </> : clusterMode ? <>
        <div className="rail-caption">Cụm quan hệ <span>{clusters.length}</span></div>
        <button className={`tree-group${!cluster ? ' current' : ''}`} onClick={() => onCluster(null)}><UnfoldVertical size={15} /><span>Tất cả các cụm</span></button>
        {clusters.map((entry, index) => <div key={entry.id} className="cluster-group">
          <button className={`tree-group${entry.id === cluster ? ' current' : ''}`} onClick={() => onCluster(entry.id)}>
            {entry.id === cluster ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>Cụm {index + 1} · {entry.name}</span><small>{entry.tables.length}</small>
          </button>
          {entry.id === cluster && entry.tables.map(id => row(tableById.get(id)!))}
        </div>)}
      </> : <>
        <div className="rail-caption">Các bảng <span>{model.tables.length}</span></div>
        {groups.map(([schema, tables]) => {
          const expanded = openGroups === null || openGroups.has(schema)
          return <div key={schema} className="cluster-group">
            <button className="tree-group" aria-expanded={expanded} onClick={() => setOpenGroups(old => {
              const next = new Set(old ?? groups.map(([group]) => group))
              if (next.has(schema)) next.delete(schema); else next.add(schema)
              return next
            })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Database size={15} /><span title={schema || name}>{schema || name}</span></button>
            {expanded && tables.map(row)}
          </div>
        })}
      </>}
    </div>
    <div className="rail-bottom"><span className="legend-title">Chú giải</span><span><KeyRound className="key-primary" size={14} /> Khóa chính</span><span><Link2 className="key-foreign" size={14} /> Khóa ngoại</span></div>
  </aside>
}

interface InspectorProps {
  model: SchemaModel
  table: Table | undefined
  selectedColumn: string | null
  selectedRelation: string | null
  tab: 'structure' | 'relations'
  onTab: (tab: 'structure' | 'relations') => void
  onEdit: (table: string, column?: string) => void
  onRelation: (id: string) => void
  onEditRelation: (id: string) => void
  onAddRelation: () => void
  onNote: (table: string) => void
}

export function Inspector({ model, table, selectedColumn, selectedRelation, tab, onTab, onEdit, onRelation, onEditRelation, onAddRelation, onNote }: InspectorProps) {
  const relations = table ? model.relations.filter(relation => relation.source === table.id || relation.target === table.id) : []
  const primary = new Set(table?.keys.filter(key => key.kind === 'primary').flatMap(key => key.columns))
  const foreign = new Set(relations.filter(relation => relation.source === table?.id).flatMap(relation => relation.columns))
  const selected = relations.find(relation => relation.id === selectedRelation)

  function relationRow(relation: ForeignKey) {
    const outgoing = relation.source === table!.id
    const other = model.tables.find(item => item.id === (outgoing ? relation.target : relation.source))
    const relationName = relation.name || (other ? tableName(other) : relation.reference.table)
    return <button className={`inspector-relation${relation.id === selectedRelation ? ' active' : ''}`} key={relation.id} onClick={() => onRelation(relation.id)}>
      <span className="relation-icon">{outgoing ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}</span>
      <span><strong title={relationName}>{relationName}</strong><small>{relationColumns(table!, relation, !outgoing)} <span aria-hidden="true">·</span> {other ? tableName(other) : relation.reference.table}</small></span>
    </button>
  }

  return <aside className="inspector" aria-label="Chi tiết lược đồ">
    <div className="rail-title inspector-title"><h2>Chi tiết bảng</h2>{table && <button className="icon-btn" title="Chỉnh sửa bảng" aria-label="Chỉnh sửa bảng" onClick={() => onEdit(table.id)}><Pencil size={16} /></button>}</div>
    {table ? <>
      <div className="object-heading"><div className="object-icon"><Table2 size={22} /></div><div><strong title={tableName(table)}>{table.name}</strong><small>{table.schema || `${table.columns.length} cột · ${relations.length} quan hệ`}</small></div></div>
      <div className="inspector-tabs" aria-label="Nội dung chi tiết">
        <button className={tab === 'structure' ? 'active' : ''} onClick={() => onTab('structure')}>Cấu trúc</button>
        <button className={tab === 'relations' ? 'active' : ''} onClick={() => onTab('relations')}>Quan hệ <span>{relations.length}</span></button>
      </div>
      <div className="inspector-scroll">
        {tab === 'structure' ? <>
          <div className="column-label"><span>Tên cột</span><span>Kiểu dữ liệu</span></div>
          {table.columns.map(column => <button className={`inspector-column${selectedColumn === column.id ? ' active' : ''}`} key={column.id} title={`Sửa cột ${column.name}`} onClick={() => onEdit(table.id, column.id)}>
            <span>{primary.has(column.id) ? <KeyRound className="key-primary" size={15} /> : foreign.has(column.id) ? <Link2 className="key-foreign" size={15} /> : <i className="column-dot" />} <strong>{column.name}</strong></span>
            <code>{column.type.toLowerCase()}{isNullable(column) && !primary.has(column.id) && <small>NULL</small>}</code>
          </button>)}
          <div className="inspector-subhead"><h3>Quan hệ</h3><button className="icon-btn" title="Thêm khóa ngoại" aria-label="Thêm khóa ngoại" onClick={onAddRelation}><Plus size={16} /></button></div>
          {relations.length ? relations.map(relationRow) : <p className="rail-empty">Chưa có quan hệ.</p>}
        </> : <>
          <div className="inspector-subhead first"><h3>Khóa ngoại</h3><button className="icon-btn" title="Thêm khóa ngoại" aria-label="Thêm khóa ngoại" onClick={onAddRelation}><Plus size={16} /></button></div>
          {relations.length ? relations.map(relationRow) : <p className="rail-empty">Chưa có quan hệ.</p>}
          {selected && <div className="relation-detail">
            <h3>Tham chiếu</h3><p>{selected.onDelete && <span>ON DELETE <code>{selected.onDelete}</code></span>}{selected.onUpdate && <span>ON UPDATE <code>{selected.onUpdate}</code></span>}{!selected.onDelete && !selected.onUpdate && <span>Hành động mặc định</span>}</p>
            <button className="button quiet" onClick={() => onEditRelation(selected.id)}><Pencil size={15} /> Sửa quan hệ</button>
          </div>}
        </>}
      </div>
      <div className="inspector-bottom"><button className="button quiet" onClick={() => onNote(table.id)}><Plus size={15} /> Chú thích cho bảng</button></div>
    </> : <p className="rail-empty">Chọn một bảng để xem các cột và quan hệ.</p>}
  </aside>
}

export function TableList({ tables, selected, onTable, onEdit }: { tables: Table[]; selected: string | null; onTable: (id: string) => void; onEdit: (id: string) => void }) {
  return <div className="table-list">
    <table><thead><tr><th>Bảng</th><th>Database</th><th>Cột</th><th>Khóa chính</th><th aria-label="Thao tác" /></tr></thead>
      <tbody>{tables.map(table => <tr key={table.id} className={table.id === selected ? 'active' : ''}>
        <td><button className="button quiet" onClick={() => onTable(table.id)}><Table2 size={16} /> {table.name}</button></td>
        <td>{table.schema || 'Mặc định'}</td><td>{table.columns.length}</td>
        <td>{table.keys.find(key => key.kind === 'primary')?.columns.map(id => table.columns.find(column => column.id === id)?.name).join(', ') || '—'}</td>
        <td><button className="icon-btn" title={`Sửa bảng ${table.name}`} aria-label={`Sửa bảng ${table.name}`} onClick={() => onEdit(table.id)}><Pencil size={15} /></button></td>
      </tr>)}</tbody>
    </table>
  </div>
}
