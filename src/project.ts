import { actions, defaultView, minimumZoom } from './model.ts'
import type { Point, Project } from './model.ts'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const string = (value: unknown): value is string => typeof value === 'string'
const array = (value: unknown, entry: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.every(entry)
const point = (value: unknown): value is Point => object(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
const nullable = (value: unknown) => value === null || string(value)
const strings = (value: unknown) => array(value, string)
const action = (value: unknown) => value === '' || actions.some(item => item === value)
const unique = (values: string[]) => new Set(values).size === values.length
const id = (value: unknown) => string(value) && /^[a-zA-Z0-9_-]+$/.test(value) && !Object.hasOwn(Object.prototype, value)

function validModel(value: unknown) {
  return object(value) && Number.isSafeInteger(value.skipped)
    && array(value.tables, table => object(table) && id(table.id) && string(table.name) && !!table.name && string(table.schema)
      && string(table.options) && strings(table.extras) && array(table.columns, column => object(column) && id(column.id) && string(column.name) && !!column.name && string(column.type) && string(column.attributes))
      && array(table.keys, key => object(key) && id(key.id) && ['primary', 'unique', 'index'].includes(String(key.kind))
        && strings(key.columns) && strings(key.tails) && string(key.head) && string(key.suffix)))
    && array(value.relations, relation => object(relation) && id(relation.id) && string(relation.name) && string(relation.source) && nullable(relation.target)
      && strings(relation.columns) && strings(relation.targetColumns) && action(relation.onDelete) && action(relation.onUpdate)
      && (relation.match === undefined || ['FULL', 'PARTIAL', 'SIMPLE'].includes(String(relation.match)))
      && object(relation.reference) && string(relation.reference.schema) && string(relation.reference.table) && strings(relation.reference.columns))
    && array(value.diagnostics, diagnostic => object(diagnostic) && Number.isSafeInteger(diagnostic.line) && string(diagnostic.message) && ['warning', 'error'].includes(String(diagnostic.level)))
}

export function readProject(text: string): Project {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('File dự án không chứa JSON hợp lệ.') }
  if (!object(parsed) || parsed.format !== 'sqlviz') throw new Error('Chọn file dự án .sqlviz.json do SQL Atlas tạo.')
  if (parsed.version !== 1) throw new Error('Phiên bản file dự án này chưa được hỗ trợ.')
  if (!string(parsed.name) || !validModel(parsed.model) || !object(parsed.positions)
    || !Object.values(parsed.positions).every(point) || !array(parsed.notes, note => object(note) && id(note.id) && string(note.text) && nullable(note.table) && point(note.position))
    || !object(parsed.view) || !point(parsed.view.viewport)) throw new Error('File dự án thiếu dữ liệu hoặc có cấu trúc không hợp lệ.')
  const project = parsed as unknown as Project
  const { model, notes, view } = project
  const tables = new Map(model.tables.map(table => [table.id, table]))
  const allNodeIds = [...model.tables.map(table => table.id), ...notes.map(note => note.id)]
  if (!unique(allNodeIds) || !unique(model.relations.map(relation => relation.id)) || model.tables.some(table => {
    const columns = new Set(table.columns.map(column => column.id))
    return columns.size !== table.columns.length || !unique(table.keys.map(key => key.id))
      || table.keys.some(key => key.columns.some(id => !columns.has(id)))
  }) || model.relations.some(relation => {
    const source = tables.get(relation.source)
    const target = relation.target === null ? null : tables.get(relation.target)
    return !source || (relation.target !== null && !target) || relation.columns.some(id => !source.columns.some(column => column.id === id))
      || Boolean(target && relation.targetColumns.some(id => id && !target.columns.some(column => column.id === id)))
  }) || notes.some(note => note.table !== null && !tables.has(note.table))) throw new Error('File dự án chứa mã bảng, cột hoặc quan hệ không hợp lệ.')
  if (!['diagram', 'clusters', 'neighbors', 'list'].includes(view.mode) || !nullable(view.schema) || !nullable(view.cluster)
    || !nullable(view.selected) || ![1, 2, 3].includes(view.depth) || typeof view.folded !== 'boolean'
    || !Number.isFinite(view.viewport.zoom) || view.viewport.zoom < minimumZoom || view.viewport.zoom > 3) throw new Error('Khung nhìn trong file dự án không hợp lệ.')
  if (view.onlyTables == null) project.view = { ...view, onlyTables: null }
  else if (!strings(view.onlyTables) || !unique(view.onlyTables) || view.onlyTables.some(table => !tables.has(table))) throw new Error('Danh sách bảng đang hiện trong file dự án không hợp lệ.')
  if (view.selected !== null && !tables.has(view.selected)) project.view = { ...project.view, selected: defaultView.selected }
  return project
}

export function download(text: string, name: string, contentType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function fileStem(name: string) {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/, '') || 'sql-atlas'
}
