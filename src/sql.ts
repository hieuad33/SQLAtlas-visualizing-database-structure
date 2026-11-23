import { actions, nameEqual, relationIssue, sqlName, tableName, tableSql } from './model.ts'
import type { Column, Diagnostic, ForeignKey, ForeignKeyAction, Reference, SchemaModel, Table, TableKey } from './model.ts'

interface Token { value: string; start: number; end: number; kind: 'word' | 'name' | 'string' | 'mark' }
interface Statement { text: string; line: number }

function* statements(input: string): Generator<Statement | null> {
  const ignored = /^(?:insert|replace|update|delete|set|lock|unlock|start|commit|rollback|drop|truncate|select|grant|revoke)\b/i
  let delimiter = ';'
  let start = -1
  let line = 1
  let startLine = 1
  let quote = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '\n') line++
    if (quote) {
      if (char === '\\' && quote !== '`') {
        if (input[++i] === '\n') line++
      } else if (char === quote) {
        if (input[i + 1] === quote) i++
        else quote = ''
      }
      continue
    }
    if (input.startsWith(delimiter, i)) {
      if (start >= 0) yield ignored.test(input.slice(start, start + 12)) ? null : { text: input.slice(start, i), line: startLine }
      start = -1
      i += delimiter.length - 1
      continue
    }
    if (char === '#' || (input.startsWith('--', i) && /\s/.test(input[i + 2] ?? ' '))) {
      while (i + 1 < input.length && input[i + 1] !== '\n') i++
      continue
    }
    if (input.startsWith('/*', i)) {
      const end = input.indexOf('*/', i + 2)
      if (end < 0) throw new Error(`Dòng ${line}: chú thích chưa đóng.`)
      for (let j = i + 2; j < end; j++) if (input[j] === '\n') line++
      i = end + 1
      continue
    }
    if (start < 0) {
      if (/\s/.test(char)) continue
      const directive = /^DELIMITER[\t ]+(\S+)/i.exec(input.slice(i, i + 100))
      if (directive) {
        delimiter = directive[1]
        i += directive[0].length - 1
        continue
      }
      start = i
      startLine = line
    }
    if (char === '`' || char === '"' || char === "'") quote = char
  }
  if (quote) throw new Error(`Dòng ${startLine}: chuỗi hoặc tên định danh chưa đóng.`)
  if (start >= 0) yield ignored.test(input.slice(start, start + 12)) ? null : { text: input.slice(start), line: startLine }
}

function tokenize(text: string): Token[] {
  const pattern = /\s+|\/\*[\s\S]*?\*\/|(?:--(?=\s)|#)[^\r\n]*|`(?:``|[^`])*`|"(?:""|\\[\s\S]|[^"\\])*"|'(?:''|\\[\s\S]|[^'\\])*'|[\p{L}\p{N}_$]+|[^\s]/gu
  return Array.from(text.matchAll(pattern), match => {
    const raw = match[0]
    const start = match.index!
    let value = raw
    let kind: Token['kind'] = 'mark'
    if (raw.startsWith('`')) {
      kind = 'name'
      value = raw.slice(1, -1).replaceAll('``', '`')
    } else if (raw.startsWith('"') || raw.startsWith("'")) kind = 'string'
    else if (/^[\p{L}\p{N}_$]/u.test(raw)) kind = 'word'
    return { value, start, end: start + raw.length, kind }
  }).filter(token => !/^(?:\s|\/\*|--\s|#)/.test(token.value) || token.kind === 'name')
}

const keyword = (token: Token | undefined) => token?.kind === 'word' ? token.value.toUpperCase() : ''
const mark = (token: Token | undefined, value: string) => token?.kind === 'mark' && token.value === value
const identifier = (token: Token | undefined): string => {
  if (!token || (token.kind !== 'name' && token.kind !== 'word' && !token.value.startsWith('"'))) throw new Error('Thiếu tên định danh.')
  return token.kind === 'string' ? token.value.slice(1, -1).replaceAll('""', '"') : token.value
}
const raw = (text: string, tokens: Token[]) => tokens.length ? text.slice(tokens[0].start, tokens.at(-1)!.end) : ''

function qualified(tokens: Token[], index: number, currentSchema: string) {
  const first = identifier(tokens[index])
  if (mark(tokens[index + 1], '.')) return { schema: first, name: identifier(tokens[index + 2]), next: index + 3 }
  return { schema: currentSchema, name: first, next: index + 1 }
}

function parenthesized(tokens: Token[], open: number) {
  if (!mark(tokens[open], '(')) throw new Error('Thiếu dấu ngoặc mở.')
  let depth = 1
  for (let i = open + 1; i < tokens.length; i++) {
    if (mark(tokens[i], '(')) depth++
    if (mark(tokens[i], ')') && --depth === 0) return { inner: tokens.slice(open + 1, i), end: i }
  }
  throw new Error('Thiếu dấu ngoặc đóng.')
}

function commaList(tokens: Token[]) {
  const parts: Token[][] = []
  let depth = 0
  let start = 0
  for (const [i, token] of tokens.entries()) {
    if (mark(token, '(')) depth++
    if (mark(token, ')')) depth--
    if (depth === 0 && mark(token, ',')) {
      parts.push(tokens.slice(start, i))
      start = i + 1
    }
  }
  parts.push(tokens.slice(start))
  return parts
}

const columnAttribute = new Set(['NULL', 'NOT', 'DEFAULT', 'VISIBLE', 'INVISIBLE', 'AUTO_INCREMENT', 'UNIQUE', 'PRIMARY', 'KEY', 'COMMENT', 'COLLATE', 'CHARACTER', 'GENERATED', 'AS', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'ON', 'COLUMN_FORMAT', 'STORAGE', 'SRID'])

function columnDefinition(text: string, tokens: Token[], id: string): Column {
  const name = identifier(tokens[0])
  let end = 2
  if (!tokens[1] || tokens[1].kind !== 'word') throw new Error(`Cột ${name} thiếu kiểu dữ liệu.`)
  while (end < tokens.length && !columnAttribute.has(keyword(tokens[end]))) {
    if (mark(tokens[end], '(')) end = parenthesized(tokens, end).end
    end++
  }
  return { id, name, type: raw(text, tokens.slice(1, end)), attributes: raw(text, tokens.slice(end)) }
}

export function parseColumnInput(name: string, type: string, attributes: string, id: string): Column {
  const definition = `${sqlName(name)} ${type} ${attributes}`.trimEnd()
  const entries = Array.from(statements(definition))
  const tokens = tokenize(definition)
  if (entries.length !== 1 || entries[0]?.text !== definition || commaList(tokens).length !== 1
    || tokens.some(token => mark(token, ';')) || !tokens.slice(1).length) throw new Error('Khai báo cột chứa cú pháp không hợp lệ.')
  let depth = 0
  for (const token of tokens) {
    if (mark(token, '(')) depth++
    if (mark(token, ')') && --depth < 0) throw new Error('Dấu ngoặc trong khai báo cột không hợp lệ.')
  }
  if (depth) throw new Error('Dấu ngoặc trong khai báo cột không hợp lệ.')
  const column = columnDefinition(definition, tokens, id)
  if (!column.type || column.type !== type.trim()) throw new Error('Nhập kiểu dữ liệu và thuộc tính vào đúng trường.')
  if (tokenize(attributes).some(token => ['PRIMARY', 'UNIQUE', 'REFERENCES'].includes(keyword(token)))) throw new Error('Thiết lập khóa chính, khóa duy nhất và khóa ngoại bằng các công cụ tương ứng.')
  return column
}

function findColumn(table: Table, name: string) {
  return table.columns.find(column => nameEqual(column.name, name))?.id ?? ''
}

function parseKey(text: string, tokens: Token[], start: number, table: Table, id: string): TableKey | null {
  const type = keyword(tokens[start])
  if (!['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL'].includes(type)) return null
  const open = tokens.findIndex(token => mark(token, '('))
  const { inner, end } = parenthesized(tokens, open)
  const parts = commaList(inner)
  if (parts.some(part => mark(part[0], '('))) return null
  const columns = parts.map(part => findColumn(table, identifier(part[0])))
  if (columns.some(column => !column)) throw new Error('Chỉ mục tham chiếu đến cột chưa được định nghĩa.')
  return {
    id, kind: type === 'PRIMARY' ? 'primary' : type === 'UNIQUE' ? 'unique' : 'index', columns,
    head: raw(text, tokens.slice(0, open)), tails: parts.map(part => part.length > 1 ? text.slice(part[0].end, part.at(-1)!.end) : ''),
    suffix: raw(text, tokens.slice(end + 1)),
  }
}

function parseReference(tokens: Token[], index: number, schema: string) {
  if (keyword(tokens[index]) !== 'REFERENCES') throw new Error('Khóa ngoại thiếu REFERENCES.')
  const qualifiedName = qualified(tokens, index + 1, schema)
  const { inner, end } = parenthesized(tokens, qualifiedName.next)
  const reference: Reference = { schema: qualifiedName.schema, table: qualifiedName.name, columns: commaList(inner).map(part => identifier(part[0])) }
  const options: Pick<ForeignKey, 'onDelete' | 'onUpdate' | 'match'> = { onDelete: '', onUpdate: '' }
  for (let i = end + 1; i < tokens.length;) {
    const word = keyword(tokens[i])
    if (word === 'MATCH' && ['FULL', 'PARTIAL', 'SIMPLE'].includes(keyword(tokens[i + 1]))) {
      options.match = keyword(tokens[i + 1])
      i += 2
      continue
    }
    const event = keyword(tokens[i + 1])
    if (word !== 'ON' || !['DELETE', 'UPDATE'].includes(event)) throw new Error('Tùy chọn khóa ngoại chưa được hỗ trợ.')
    const action = actions.find(value => value === [keyword(tokens[i + 2]), keyword(tokens[i + 3])].join(' '))
      ?? actions.find(value => value === keyword(tokens[i + 2]))
    if (!action) throw new Error('Hành động khóa ngoại chưa được hỗ trợ.')
    options[event === 'DELETE' ? 'onDelete' : 'onUpdate'] = action
    i += action.includes(' ') ? 4 : 3
  }
  return { reference, ...options }
}

function parseForeign(tokens: Token[], start: number, table: Table, id: string): ForeignKey {
  const open = tokens.findIndex((token, index) => index > start && mark(token, '('))
  const { inner, end } = parenthesized(tokens, open)
  const columns = commaList(inner).map(part => findColumn(table, identifier(part[0])))
  if (columns.some(column => !column)) throw new Error('Khóa ngoại tham chiếu đến cột nguồn chưa được định nghĩa.')
  const name = start === 2 ? identifier(tokens[1]) : open === start + 3 ? identifier(tokens[start + 2]) : ''
  return { id, name, source: table.id, columns, target: null, targetColumns: [], ...parseReference(tokens, end + 1, table.schema) }
}

function constraintStart(tokens: Token[]) {
  if (keyword(tokens[0]) !== 'CONSTRAINT') return 0
  return ['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].includes(keyword(tokens[1])) ? 1 : 2
}

const isConstraint = (tokens: Token[]) => ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'FOREIGN', 'CHECK', 'CONSTRAINT'].includes(keyword(tokens[0]))

function addConstraint(text: string, tokens: Token[], table: Table, relations: ForeignKey[], nextId: () => string) {
  const start = constraintStart(tokens)
  if (keyword(tokens[start]) === 'FOREIGN') {
    relations.push(parseForeign(tokens, start, table, nextId()))
    return
  }
  const key = parseKey(text, tokens, start, table, nextId())
  if (key) table.keys.push(key)
  else table.extras.push(raw(text, tokens))
}

function appendColumn(text: string, tokens: Token[], table: Table, relations: ForeignKey[], nextId: () => string, previous?: Column) {
  let placement: string | null = null
  if (keyword(tokens.at(-1)) === 'FIRST') {
    placement = ''
    tokens = tokens.slice(0, -1)
  } else if (keyword(tokens.at(-2)) === 'AFTER') {
    placement = identifier(tokens.at(-1))
    tokens = tokens.slice(0, -2)
  }
  const column = columnDefinition(text, tokens, previous?.id ?? nextId())
  if (table.columns.some(item => item.id !== previous?.id && nameEqual(item.name, column.name))) throw new Error(`Cột ${column.name} xuất hiện nhiều lần.`)
  const attrTokens = tokenize(column.attributes)
  const inlineReference = attrTokens.findIndex(token => keyword(token) === 'REFERENCES')
  if (inlineReference >= 0) {
    relations.push({ id: nextId(), name: '', source: table.id, columns: [column.id], target: null, targetColumns: [],
      ...parseReference(attrTokens, inlineReference, table.schema) })
    column.attributes = column.attributes.slice(0, attrTokens[inlineReference].start).trimEnd()
  }
  const remaining = tokenize(column.attributes)
  let depth = 0
  const inlineKeys = remaining.flatMap((token, index) => {
    if (mark(token, '(')) depth++
    if (mark(token, ')')) depth--
    const word = keyword(token)
    if (depth || (word !== 'PRIMARY' && word !== 'UNIQUE')) return []
    const end = keyword(remaining[index + 1]) === 'KEY' ? remaining[index + 1].end : token.end
    const kind = word === 'PRIMARY' ? 'primary' : 'unique'
    if (!table.keys.some(key => key.kind === kind && key.columns.length === 1 && key.columns[0] === column.id)) {
      table.keys.push({ id: nextId(), kind, columns: [column.id], head: `${word} KEY`, tails: [''], suffix: '' })
    }
    return [{ start: token.start, end }]
  })
  for (const key of inlineKeys.reverse()) column.attributes = `${column.attributes.slice(0, key.start)}${column.attributes.slice(key.end)}`.trimEnd()
  column.attributes = column.attributes.trim()
  if (placement === null) {
    if (previous) table.columns[table.columns.indexOf(previous)] = column
    else table.columns.push(column)
  } else {
    if (previous) table.columns = table.columns.filter(item => item.id !== previous.id)
    const index = placement ? table.columns.findIndex(item => nameEqual(item.name, placement)) : -1
    if (placement && index < 0) throw new Error(`Không tìm thấy cột ${placement} sau từ khóa AFTER.`)
    table.columns.splice(index + 1, 0, column)
  }
  return column
}

export function parseSql(input: string): SchemaModel {
  const tables: Table[] = []
  const relations: ForeignKey[] = []
  const diagnostics: Diagnostic[] = []
  let schema = ''
  let sequence = 0
  let skipped = 0
  const nextId = () => `sql-${++sequence}`
  const findTable = (value: Pick<Table, 'schema' | 'name'>) => tables.find(table => table.schema === value.schema && table.name === value.name)
  for (const statement of statements(input)) {
    if (!statement) {
      skipped++
      continue
    }
    const { text, line } = statement
    const tokens = tokenize(text)
    const verb = keyword(tokens[0])
    const subject = keyword(tokens[1])
    try {
      if (verb === 'USE') {
        schema = identifier(tokens[1])
      } else if (verb === 'CREATE' && (subject === 'TABLE' || (subject === 'TEMPORARY' && keyword(tokens[2]) === 'TABLE'))) {
        const start = subject === 'TABLE' ? 2 : 3
        const name = qualified(tokens, keyword(tokens[start]) === 'IF' ? start + 3 : start, schema)
        if (findTable(name)) throw new Error(`Bảng ${tableName(name)} xuất hiện nhiều lần.`)
        const { inner, end } = parenthesized(tokens, name.next)
        const tail = tokens.slice(end + 1)
        if (tail.some(token => ['SELECT', 'AS'].includes(keyword(token)))) throw new Error('CREATE TABLE AS SELECT chưa được hỗ trợ.')
        const table: Table = { id: nextId(), schema: name.schema, name: name.name, columns: [], keys: [], extras: [], options: raw(text, tail) }
        const tableRelations: ForeignKey[] = []
        const parts = commaList(inner)
        for (const part of parts.filter(tokens => !isConstraint(tokens))) appendColumn(text, part, table, tableRelations, nextId)
        for (const part of parts.filter(isConstraint)) addConstraint(text, part, table, tableRelations, nextId)
        tables.push(table)
        relations.push(...tableRelations)
      } else if (verb === 'ALTER' && subject === 'TABLE') {
        const name = qualified(tokens, 2, schema)
        const parts = commaList(tokens.slice(name.next))
        if (parts.length === 1 && ['ENABLE', 'DISABLE'].includes(keyword(parts[0][0])) && keyword(parts[0][1]) === 'KEYS') continue
        const table = findTable(name)
        if (!table) throw new Error(`ALTER TABLE tham chiếu đến bảng chưa được nhập: ${tableName(name)}.`)
        const draft = { ...table, columns: [...table.columns], keys: [...table.keys], extras: [...table.extras] }
        const added: ForeignKey[] = []
        const renames: { oldName: string; newName: string; earlier: number }[] = []
        for (const part of parts) {
          const action = keyword(part[0])
          const definition = part.slice(keyword(part[1]) === 'COLUMN' ? 2 : 1)
          if (action === 'ADD') {
            if (isConstraint(definition)) addConstraint(text, definition, draft, added, nextId)
            else appendColumn(text, definition, draft, added, nextId)
          } else if (action === 'MODIFY' || action === 'CHANGE') {
            const oldName = identifier(definition[0])
            const previous = draft.columns.find(column => nameEqual(column.name, oldName))
            if (!previous) throw new Error(`Không tìm thấy cột ${oldName} trong bảng ${tableName(name)}.`)
            const earlier = added.length
            const column = appendColumn(text, action === 'MODIFY' ? definition : definition.slice(1), draft, added, nextId, previous)
            if (!nameEqual(previous.name, column.name)) renames.push({ oldName: previous.name, newName: column.name, earlier })
          } else if (action === 'AUTO_INCREMENT' && /^AUTO_INCREMENT\s*=?\s*\d+$/i.test(raw(text, part))) {
            const option = raw(text, part)
            draft.options = `${draft.options.replace(/\bAUTO_INCREMENT\s*=?\s*\d+/i, '').trim()} ${option}`.trim()
          } else throw new Error(`Chưa hỗ trợ câu ALTER TABLE này trên bảng ${tableName(name)}.`)
        }
        table.columns = draft.columns
        table.keys = draft.keys
        table.extras = draft.extras
        table.options = draft.options
        for (const rename of renames) {
          for (const edge of [...relations, ...added.slice(0, rename.earlier)]) {
            if (edge.reference.schema === table.schema && edge.reference.table === table.name) {
              edge.reference.columns = edge.reference.columns.map(column => nameEqual(column, rename.oldName) ? rename.newName : column)
            }
          }
        }
        relations.push(...added)
      } else if (verb === 'CREATE' && (subject === 'INDEX' || (['UNIQUE', 'FULLTEXT', 'SPATIAL'].includes(subject) && keyword(tokens[2]) === 'INDEX'))) {
        const on = tokens.findIndex((token, index) => index > 1 && keyword(token) === 'ON')
        if (on < 0) throw new Error('CREATE INDEX thiếu bảng đích.')
        const name = qualified(tokens, on + 1, schema)
        const table = findTable(name)
        if (!table) throw new Error(`CREATE INDEX tham chiếu đến bảng chưa được nhập: ${tableName(name)}.`)
        const definition = `${raw(text, tokens.slice(1, on))} ${raw(text, tokens.slice(name.next))}`
        addConstraint(definition, tokenize(definition), table, relations, nextId)
      } else if (verb === 'CREATE' && ['DATABASE', 'SCHEMA'].includes(subject)) {
        continue
      } else if (verb === 'CREATE' || verb === 'ALTER' || verb === 'RENAME') {
        diagnostics.push({ line, level: verb === 'RENAME' || (verb === 'ALTER' && subject !== 'VIEW') ? 'error' : 'warning', message: `Đã bỏ qua ${verb} ${subject || '…'}.` })
      } else {
        skipped++
      }
    } catch (error) {
      diagnostics.push({ line, level: 'error', message: error instanceof Error ? error.message : 'Không đọc được câu lệnh.' })
    }
  }
  for (const relation of relations) {
    const target = findTable({ schema: relation.reference.schema, name: relation.reference.table })
    relation.target = target?.id ?? null
    relation.targetColumns = target?.columns ? relation.reference.columns.map(name => findColumn(target, name)) : []
  }
  return { tables, relations, diagnostics, skipped }
}

const actionSql = (event: string, action: ForeignKeyAction | '') => action ? ` ON ${event} ${action}` : ''

export function exportProblems(model: SchemaModel): string[] {
  return [
    ...model.diagnostics.filter(diagnostic => diagnostic.level === 'error').map(diagnostic => `Dòng ${diagnostic.line}: ${diagnostic.message}`),
    ...model.relations.flatMap(relation => {
      const issue = relationIssue(model, relation)
      if (!issue) return []
      const source = model.tables.find(table => table.id === relation.source)!
      return [`${tableName(source)}${relation.name ? ` · ${relation.name}` : ''}: ${issue}`]
    }),
  ]
}

export function exportSql(model: SchemaModel): string {
  const lines = ['-- SQL Atlas · MySQL / MariaDB']
  const schemas = [...new Set(model.tables.map(table => table.schema).filter(Boolean))]
  for (const schema of schemas) lines.push(`CREATE DATABASE IF NOT EXISTS ${sqlName(schema)};`)
  for (const table of model.tables) {
    const definitions = table.columns.map(column => `${sqlName(column.name)} ${column.type}${column.attributes ? ` ${column.attributes}` : ''}`)
    const columns = new Map(table.columns.map(column => [column.id, column.name]))
    for (const key of table.keys) {
      const parts = key.columns.map((id, index) => `${sqlName(columns.get(id)!)}${key.tails[index] ?? ''}`)
      definitions.push(`${key.head} (${parts.join(', ')})${key.suffix ? ` ${key.suffix}` : ''}`)
    }
    definitions.push(...table.extras)
    lines.push('', `CREATE TABLE ${tableSql(table)} (\n  ${definitions.join(',\n  ')}\n)${table.options ? ` ${table.options}` : ''};`)
  }
  const tables = new Map(model.tables.map(table => [table.id, table]))
  for (const relation of model.relations) {
    const source = tables.get(relation.source)!
    const target = relation.target ? tables.get(relation.target) : undefined
    const from = relation.columns.map(id => sqlName(source.columns.find(column => column.id === id)!.name)).join(', ')
    const to = (target ? relation.targetColumns.map((id, i) => target.columns.find(column => column.id === id)?.name || relation.reference.columns[i]) : relation.reference.columns).map(sqlName).join(', ')
    const targetName = target ?? { schema: relation.reference.schema, name: relation.reference.table }
    lines.push('', `ALTER TABLE ${tableSql(source)} ADD ${relation.name ? `CONSTRAINT ${sqlName(relation.name)} ` : ''}FOREIGN KEY (${from}) REFERENCES ${tableSql(targetName)} (${to})${relation.match ? ` MATCH ${relation.match}` : ''}${actionSql('DELETE', relation.onDelete)}${actionSql('UPDATE', relation.onUpdate)};`)
  }
  return `${lines.join('\n')}\n`
}
