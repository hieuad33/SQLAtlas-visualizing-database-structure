import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clustersOf, graphIndex, relatedTables, search, searchIndex, shortestPath } from '../src/graph.ts'
import { createProject, relationIssue, tableName } from '../src/model.ts'
import type { SchemaModel } from '../src/model.ts'
import { readProject } from '../src/project.ts'
import { exportProblems, exportSql, parseColumnInput, parseSql } from '../src/sql.ts'

const fixture = readFileSync(new URL('fixtures/schema.sql', import.meta.url), 'utf8')

function structure(model: SchemaModel) {
  return {
    tables: model.tables.map(table => ({ name: tableName(table), options: table.options,
      columns: table.columns.map(column => [column.name, column.type, column.attributes]),
      keys: table.keys.map(key => [key.kind, key.columns.map(id => table.columns.find(column => column.id === id)!.name), key.tails]),
    })),
    relations: model.relations.map(edge => [edge.name, edge.reference, edge.onDelete, edge.onUpdate]),
  }
}

test('reads a dump with separate indexes, auto-increment, self-reference, and a foreign-key cycle', () => {
  const model = parseSql(fixture)
  assert.deepEqual(model.diagnostics, [])
  assert.equal(model.skipped, 1)
  assert.equal(model.tables.length, 3)
  assert.equal(model.relations.length, 3)
  assert.equal(model.tables[1].columns[0].attributes, 'NOT NULL AUTO_INCREMENT')
  assert.equal(model.tables[1].options, 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 AUTO_INCREMENT=7')
  assert.deepEqual(exportProblems(model), [])
  const sql = exportSql(model)
  assert.doesNotMatch(sql, /INSERT/i)
  assert.ok(sql.indexOf('ALTER TABLE') > sql.lastIndexOf('CREATE TABLE'))
  assert.deepEqual(structure(parseSql(sql)), structure(model))
})

test('handles quoted identifiers, comments, delimiters, and effective schema changes from ALTER', () => {
  const model = parseSql(`
    USE \`t\`;
    CREATE TABLE \`a,b\` (\`odd\`\`id\` INT PRIMARY KEY, message VARCHAR(50) DEFAULT 'b,c;d');
    CREATE TABLE refs (id INT PRIMARY KEY, other INT, FOREIGN KEY (other) REFERENCES \`a,b\` (\`odd\`\`id\`));
    ALTER TABLE \`a,b\` CHANGE COLUMN \`odd\`\`id\` \`new name\` INT NOT NULL, ADD COLUMN code INT AFTER \`new name\`;
    CREATE INDEX idx_code ON \`a,b\` (code);
    DELIMITER $$
    CREATE PROCEDURE sample() BEGIN SELECT '#,;'; END$$
    DELIMITER ;
  `)
  assert.equal(model.diagnostics.length, 1)
  assert.equal(model.diagnostics[0].level, 'warning')
  assert.deepEqual(model.tables[0].columns.map(column => column.name), ['new name', 'code', 'message'])
  assert.deepEqual(model.tables[0].keys.map(key => key.kind), ['primary', 'index'])
  assert.deepEqual(model.relations[0].reference.columns, ['new name'])
  assert.deepEqual(exportProblems(model), [])
  assert.match(exportSql(model), /REFERENCES `t`\.`a,b` \(`new name`\)/)
})

test('keeps valid tables when a structural statement is unsupported, and blocks a partial export', () => {
  const model = parseSql('CREATE TABLE example (id INT);\nALTER TABLE example ADD KEY (id), DROP COLUMN id;\nCREATE TABLE bad LIKE example;')
  assert.equal(model.tables.length, 1)
  assert.equal(model.tables[0].keys.length, 0)
  assert.deepEqual(model.diagnostics.map(issue => issue.line), [2, 3])
  assert.equal(exportProblems(model).length, 2)
  assert.throws(() => parseSql("CREATE TABLE broken (name varchar(50) DEFAULT 'open);"), /chưa đóng/)
  assert.throws(() => parseColumnInput('id', 'INT', '); DROP TABLE t', 'col'), /không hợp lệ/)
  assert.deepEqual(parseColumnInput('label', 'DECIMAL(12, 2)', "NOT NULL COMMENT 'a; b'", 'col'), {
    id: 'col', name: 'label', type: 'DECIMAL(12, 2)', attributes: "NOT NULL COMMENT 'a; b'",
  })
})

test('validates types, unique targets and nullable source columns for new relations', () => {
  const model = parseSql(fixture)
  const relation = model.relations.find(edge => edge.name === 'fk_previous')!
  assert.equal(relationIssue(model, relation, true), null)
  assert.match(relationIssue(model, { ...relation, columns: [model.tables[1].columns[0].id], onDelete: 'SET NULL' }, true)!, /NULL/)
  assert.match(relationIssue(model, { ...relation, targetColumns: [model.tables[1].columns[1].id] }, true)!, /khóa/)
  assert.match(relationIssue(model, { ...relation, targetColumns: [model.tables[0].columns[0].id] }, true)!, /cột/)
})

test('traverses connected components and finds a shortest path without following cycles indefinitely', () => {
  const model = parseSql(fixture)
  const graph = graphIndex(model)
  const [parent, child, isolated] = model.tables.map(table => table.id)
  assert.deepEqual(clustersOf(model, graph).map(cluster => cluster.tables.length), [2, 1])
  assert.deepEqual([...relatedTables(graph, child, 3)], [child, parent])
  assert.deepEqual(shortestPath(graph, parent, child)?.tables, [parent, child])
  assert.equal(shortestPath(graph, parent, isolated), null)
})

test('indexes and traverses 500 tables, ranking exact names over partial matches', () => {
  const model = parseSql(Array.from({ length: 500 }, (_, index) => `CREATE TABLE tbl_${index} (id BIGINT PRIMARY KEY, parent_id BIGINT${index ? `, CONSTRAINT fk_${index} FOREIGN KEY (parent_id) REFERENCES tbl_${index - 1} (id)` : ''});`).join('\n'))
  const index = searchIndex(model)
  assert.equal(model.diagnostics.length, 0)
  assert.equal(search(index, 'tbl_49')[0].name, 'tbl_49')
  assert.equal(search(index, 'parent_id tbl_499')[0].kind, 'column')
  assert.equal(search(index, 'fk_499')[0].kind, 'relation')
  const graph = graphIndex(model)
  assert.equal(relatedTables(graph, model.tables[0].id, 3).size, 4)
  assert.equal(shortestPath(graph, model.tables[0].id, model.tables[499].id)?.relations.length, 499)
})

test('round-trips a project with notes, layout, view settings and edited schema', () => {
  const project = createProject('Import kiểm thử', parseSql(fixture))
  const table = project.model.tables[1]
  table.columns[0].name = 'record_id'
  project.notes.push({ id: 'note-1', text: 'Gắn với mục đang sửa', table: table.id, position: { x: 10, y: -20 } })
  project.positions[table.id] = { x: -300, y: 95 }
  project.view = { ...project.view, mode: 'neighbors', schema: 'atlas_qa', selected: table.id, onlyTables: [table.id], depth: 3, viewport: { x: 31, y: 45, zoom: 0.7 } }
  assert.deepEqual(readProject(JSON.stringify(project)), project)
  assert.equal(readProject(JSON.stringify({ ...project, view: { ...project.view, onlyTables: undefined } })).view.onlyTables, null)
  assert.throws(() => readProject(JSON.stringify({ ...project, view: { ...project.view, onlyTables: ['unknown'] } })), /Danh sách bảng/)
  assert.throws(() => readProject(JSON.stringify({ ...project, version: 4 })), /Phiên bản/)
  assert.throws(() => readProject(JSON.stringify({ ...project, notes: [{ ...project.notes[0], table: 'missing' }] })), /không hợp lệ/)
})
