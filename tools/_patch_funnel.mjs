import fs from 'node:fs'

const p = 'lib/tools.js'
let s = fs.readFileSync(p, 'utf8')

s = s.replace(
  "import { rankItems, cosineVec, fuseRankings } from './recall.js'",
  "import { searchFunnel, funnelLine } from './funnel.js'",
)
s = s.replace("import { embedReady, embedTexts } from './llm.js'\n", '')

const start = s.indexOf('      const pool = []')
const end = s.indexOf("    },\n  })\n\n  reg(searchSpec('search_memory'")
if (start < 0 || end < 0) {
  console.error('markers', start, end)
  process.exit(1)
}

const body = `      const top = searchFunnel(scopes, { query: q, tags, hops: true, topK: 8 }).slice(0, 8)
      return {
        ok: true,
        count: top.length,
        results: top.map((x) => ({
          id: x.id,
          scope: x.scope,
          summary: x.summary,
          tags: x.tags,
          weight: Number((x.weight || 0).toFixed(2)),
          timeline: x.timeline,
          why: x.why.join('；'),
        })),
        text: top.map((x) => funnelLine(x) + (x.hop ? '（' + x.why[x.why.length - 1] + '）' : '')).join('\\n'),
      }
`
s = s.slice(0, start) + body + s.slice(end)

// schema 补 why 字段
s = s.replace(
  "                weight: { type: 'number' },\n                timeline: { type: 'string' },",
  "                weight: { type: 'number' },\n                timeline: { type: 'string' },\n                why: { type: 'string' },",
)

fs.writeFileSync(p, s)
console.log('ok')
