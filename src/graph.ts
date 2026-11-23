import { tableName } from './model.ts'
import type { SchemaModel } from './model.ts'

export interface Cluster { id: string; name: string; tables: string[] }
export type SearchKind = 'table' | 'column' | 'relation'
export interface SearchItem { kind: SearchKind; id: string; table: string; name: string; detail: string }

export function graphIndex(model: SchemaModel) {
  const neighbors = new Map(model.tables.map(table => [table.id, [] as { table: string; relation: string }[]]))
  for (const relation of model.relations) {
    if (!relation.target || !neighbors.has(relation.target)) continue
    neighbors.get(relation.source)?.push({ table: relation.target, relation: relation.id })
    if (relation.source !== relation.target) neighbors.get(relation.target)?.push({ table: relation.source, relation: relation.id })
  }
  return neighbors
}

export function relatedTables(graph: ReturnType<typeof graphIndex>, table: string, depth: number) {
  const found = new Set([table])
  let layer = [table]
  for (let step = 0; step < depth && layer.length; step++) {
    const next: string[] = []
    for (const id of layer) for (const adjacent of graph.get(id) ?? []) {
      if (found.has(adjacent.table)) continue
      found.add(adjacent.table)
      next.push(adjacent.table)
    }
    layer = next
  }
  return found
}

export function clustersOf(model: SchemaModel, graph: ReturnType<typeof graphIndex>): Cluster[] {
  const remaining = new Set(graph.keys())
  const tables = new Map(model.tables.map(table => [table.id, table]))
  const clusters: Cluster[] = []
  for (const id of remaining) {
    const component = [...relatedTables(graph, id, Infinity)]
    for (const member of component) remaining.delete(member)
    const representative = component.toSorted((a, b) => (graph.get(b)?.length ?? 0) - (graph.get(a)?.length ?? 0)
      || tableName(tables.get(a)!).localeCompare(tableName(tables.get(b)!)))[0]
    clusters.push({ id: component.toSorted()[0], name: tables.get(representative)!.name, tables: component })
  }
  return clusters.toSorted((a, b) => b.tables.length - a.tables.length || a.name.localeCompare(b.name))
}

export function shortestPath(graph: ReturnType<typeof graphIndex>, start: string, end: string, allowed?: Set<string>) {
  if (!graph.has(start) || !graph.has(end)) return null
  const previous = new Map<string, { table: string; relation: string } | null>([[start, null]])
  const queue = [start]
  for (let index = 0; index < queue.length && !previous.has(end); index++) {
    const table = queue[index]
    for (const next of graph.get(table) ?? []) {
      if (previous.has(next.table) || (allowed && !allowed.has(next.table))) continue
      queue.push(next.table)
      previous.set(next.table, { table, relation: next.relation })
    }
  }
  if (!previous.has(end)) return null
  const tables = [end]
  const relations: string[] = []
  for (let next = previous.get(end); next; next = previous.get(next.table)) {
    tables.unshift(next.table)
    relations.unshift(next.relation)
  }
  return { tables, relations }
}

const searchText = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd')

export function searchIndex(model: SchemaModel) {
  const tables = new Map(model.tables.map(table => [table.id, table]))
  const entries: SearchItem[] = []
  for (const table of model.tables) {
    entries.push({ kind: 'table', id: table.id, table: table.id, name: table.name, detail: tableName(table) })
    for (const column of table.columns) entries.push({ kind: 'column', id: column.id, table: table.id, name: column.name, detail: tableName(table) })
  }
  for (const relation of model.relations) {
    const table = tables.get(relation.source)!
    const target = tables.get(relation.target ?? '')
    const sourceColumns = relation.columns.map(id => table.columns.find(column => column.id === id)?.name ?? '').join(', ')
    entries.push({ kind: 'relation', id: relation.id, table: table.id, name: relation.name || sourceColumns, detail: `${tableName(table)} → ${target ? tableName(target) : relation.reference.table}` })
  }
  return entries.map(item => ({ item, name: searchText(item.name), text: searchText(`${item.name} ${item.detail}`) }))
}

export function search(index: ReturnType<typeof searchIndex>, query: string, limit = 40) {
  const needle = searchText(query.trim())
  if (!needle) return []
  const terms = needle.split(/\s+/)
  return index.flatMap(({ item, name, text }) => {
    if (!terms.every(term => text.includes(term))) return []
    const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3
    return [{ item, score }]
  }).sort((a, b) => a.score - b.score || a.item.kind.localeCompare(b.item.kind) || a.item.name.localeCompare(b.item.name))
    .slice(0, limit).map(result => result.item)
}
