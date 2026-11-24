import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildGenericRequest, buildQwenMtRequest, isQwenMtStreamingModel } from '../../src/translation-contracts.js'
import { buildReadingRequest } from '../../src/reading-support.js'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('Pass the generated assets directory.')

const text = ''
const model = 'model-placeholder'
const contracts = {
  translation: buildGenericRequest({ model, text }),
  guide: buildReadingRequest({ model, text }),
  qwenMt: buildQwenMtRequest({ model: 'qwen-mt-flash', text }),
  streamingQwenMtModels: ['qwen-mt-flash', 'qwen-mt-lite'].filter(isQwenMtStreamingModel),
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, 'model-contracts.json'), `${JSON.stringify(contracts, null, 2)}\n`)
