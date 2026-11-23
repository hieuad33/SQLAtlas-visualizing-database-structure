export type ViewMode = 'diagram' | 'clusters' | 'neighbors' | 'list'

export interface Column {
  id: string
  name: string
  type: string
  attributes: string
}

export interface TableKey {
  id: string
  kind: 'primary' | 'unique' | 'index'
  columns: string[]
  head: string
  tails: string[]
  suffix: string
}

export interface Table {
  id: string
  schema: string
  name: string
  columns: Column[]
  keys: TableKey[]
  extras: string[]
  options: string
}

export const actions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'] as const
export type ForeignKeyAction = typeof actions[number]

export interface Reference {
  schema: string
  table: string
  columns: string[]
}

export interface ForeignKey {
  id: string
  name: string
  source: string
  columns: string[]
  target: string | null
  targetColumns: string[]
  reference: Reference
  onDelete: ForeignKeyAction | ''
  onUpdate: ForeignKeyAction | ''
  match?: string
}

export interface Diagnostic {
  line: number
  message: string
  level: 'warning' | 'error'
}

export interface SchemaModel {
  tables: Table[]
  relations: ForeignKey[]
  diagnostics: Diagnostic[]
  skipped: number
}

export interface Point { x: number; y: number }
export const minimumZoom = 0.001
export interface Note {
  id: string
  text: string
  table: string | null
  position: Point
}

export interface ViewState {
  mode: ViewMode
  schema: string | null
  cluster: string | null
  selected: string | null
  onlyTables: string[] | null
  depth: number
  folded: boolean
  viewport: Point & { zoom: number }
}

export interface Project {
  format: 'sqlviz'
  version: 1
  name: string
  model: SchemaModel
  notes: Note[]
  positions: Record<string, Point>
  view: ViewState
}

export const defaultView: ViewState = {
  mode: 'diagram', schema: null, cluster: null, selected: null, onlyTables: null, depth: 1,
  folded: false, viewport: { x: 0, y: 0, zoom: 1 },
}

export function createProject(name: string, model: SchemaModel): Project {
  return { format: 'sqlviz', version: 1, name, model, notes: [], positions: {}, view: { ...defaultView, selected: model.tables[0]?.id ?? null } }
}

export const newId = () => crypto.randomUUID()
export const tableName = (table: Pick<Table, 'schema' | 'name'>) => table.schema ? `${table.schema}.${table.name}` : table.name
export const sqlName = (name: string) => `\`${name.replaceAll('`', '``')}\``
export const tableSql = (table: Pick<Table, 'schema' | 'name'>) => table.schema ? `${sqlName(table.schema)}.${sqlName(table.name)}` : sqlName(table.name)
export const nameEqual = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

export function columnExists(table: Table, id: string) {
  return table.columns.some(column => column.id === id)
}

export function isNullable(column: Column) {
  return !/\bNOT\s+NULL\b/i.test(column.attributes.replace(/'(?:''|\\.|[^'])*'/g, ''))
}

export function keyMatches(table: Table, columns: string[], unique = true) {
  return table.keys.some(key => (!unique || key.kind !== 'index') && (!unique || key.columns.length === columns.length)
    && columns.every((id, i) => key.columns[i] === id && !key.tails[i]?.trim().startsWith('(')))
}

export function relationIssue(model: SchemaModel, relation: ForeignKey, editing = false): string | null {
  const source = model.tables.find(table => table.id === relation.source)
  const target = model.tables.find(table => table.id === relation.target)
  if (!source || !target) return 'Chưa tìm thấy bảng được tham chiếu.'
  if (!relation.columns.length || relation.columns.length !== relation.targetColumns.length) return 'Hai phía phải có cùng số lượng cột.'
  if (new Set(relation.columns).size !== relation.columns.length || new Set(relation.targetColumns).size !== relation.targetColumns.length) return 'Mỗi cột chỉ được chọn một lần trong một khóa ngoại.'
  const types = (column: Column) => column.type.toLowerCase().replace(/\binteger\b/g, 'int').replace(/\b(int|bigint|smallint|mediumint|tinyint)\s*\(\d+\)/g, '$1').replace(/\s+/g, ' ').trim()
  for (const [index, id] of relation.columns.entries()) {
    const from = source.columns.find(column => column.id === id)
    const to = target.columns.find(column => column.id === relation.targetColumns[index])
    if (!from || !to) return 'Chưa tìm thấy cột được tham chiếu.'
    const fromType = types(from)
    const toType = types(to)
    const textType = /^(?:var)?(?:char|binary)\s*\(/i
    const compatibleText = textType.test(fromType) && textType.test(toType)
      && fromType.split('(')[0].trim() === toType.split('(')[0].trim()
    if (fromType !== toType && !compatibleText) return `Kiểu dữ liệu của ${from.name} và ${to.name} cần tương thích.`
    if ((relation.onDelete === 'SET NULL' || relation.onUpdate === 'SET NULL')
      && (!isNullable(from) || source.keys.some(key => key.kind === 'primary' && key.columns.includes(from.id)))) return `${from.name} phải cho phép NULL khi dùng SET NULL.`
  }
  if (!keyMatches(target, relation.targetColumns, editing)) return editing ? 'Các cột đích phải tạo thành khóa chính hoặc khóa duy nhất.' : 'Các cột đích cần có chỉ mục phù hợp.'
  if (editing && (relation.onDelete === 'SET DEFAULT' || relation.onUpdate === 'SET DEFAULT')) return 'SET DEFAULT không được hỗ trợ cho khóa ngoại InnoDB.'
  if (relation.name && model.relations.some(other => other.id !== relation.id && nameEqual(other.name, relation.name)
    && model.tables.find(table => table.id === other.source)?.schema === source.schema)) return 'Tên khóa ngoại đã được dùng trong database này.'
  return null
}
