import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

export interface EmbeddingConfig {
  model: string
  batchSize: number
  normalize: boolean
}

export class EmbeddingService {
  private modelName: string
  private extractor: FeatureExtractionPipeline | null = null

  constructor(private config: EmbeddingConfig) {
    this.modelName = config.model
  }

  async load(): Promise<void> {
    this.extractor = (await pipeline(
      'feature-extraction',
      this.config.model,
    )) as unknown as FeatureExtractionPipeline
  }

  async embed(
    texts: string[],
    normalize?: boolean,
  ): Promise<{ embeddings: number[][]; dimensions: number }> {
    if (!this.extractor) throw new Error('Embedding model not loaded')

    const doNormalize = normalize ?? this.config.normalize
    const allEmbeddings: number[][] = []
    let dimensions = 0

    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize)
      const output = await this.extractor(batch, { pooling: 'mean', normalize: doNormalize })
      const batchEmbeddings = output.tolist() as number[][]
      if (dimensions === 0 && batchEmbeddings.length > 0) {
        dimensions = batchEmbeddings[0].length
      }
      allEmbeddings.push(...batchEmbeddings)
    }

    return { embeddings: allEmbeddings, dimensions }
  }

  getModelName(): string {
    return this.modelName
  }

  getDimensions(): number {
    return 768
  }

  getDevice(): string {
    return 'cpu'
  }
}
