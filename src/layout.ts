import type { ElkNode } from 'elkjs/lib/elk-api.js'
import type { Point, SchemaModel } from './model'

export const nodeWidth = 235
export const nodeHeight = (columns: number, folded: boolean) => 41 + (folded ? 0 : columns * 26 + 8)

export async function autoLayout(model: SchemaModel, folded: boolean): Promise<Record<string, Point>> {
  const [{ default: ELK }, { default: workerUrl }] = await Promise.all([
    import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?url'),
  ])
  const elk = new ELK({ workerFactory: () => new Worker(workerUrl) })
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '68',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100', 'elk.spacing.componentComponent': '96',
    },
    children: model.tables.map(table => ({ id: table.id, width: nodeWidth, height: nodeHeight(table.columns.length, folded) })),
    edges: model.relations.flatMap(relation => relation.target && relation.target !== relation.source
      ? [{ id: relation.id, sources: [relation.target], targets: [relation.source] }] : []),
  }
  try {
    const result = await elk.layout(graph)
    return Object.fromEntries((result.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  } finally {
    elk.terminateWorker()
  }
}

export function fallbackPosition(index: number): Point {
  return { x: index % 4 * 320, y: Math.floor(index / 4) * 240 }
}
