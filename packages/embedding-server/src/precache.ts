import { pipeline } from '@xenova/transformers'

const model = process.env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5'

pipeline('feature-extraction', model)
  .then(() => {
    console.log(`Model "${model}" cached successfully.`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(`Failed to cache model "${model}":`, err)
    process.exit(1)
  })
