import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

export interface EmbeddingConfig {
  model: string
  batchSize: number
  normalize: boolean
  device: 'cpu' | 'cuda' | 'mps' | 'wasm'
  quantized: boolean
  dtype?: 'fp32' | 'fp16' | 'int8'
}

const SUPPORTED_DEVICES = ['cpu', 'cuda', 'mps', 'wasm'] as const
const SUPPORTED_DTYPES = ['fp32', 'fp16', 'int8'] as const

export function resolveDevice(value: string | undefined): EmbeddingConfig['device'] {
  if (value && (SUPPORTED_DEVICES as readonly string[]).includes(value)) {
    return value as EmbeddingConfig['device']
  }
  if (value) {
    throw new Error(
      `Unsupported EMBEDDING_DEVICE "${value}". Supported: ${SUPPORTED_DEVICES.join(', ')}. ` +
        `Dimension/device migration hint: if the model or device changes, re-verify the embedding dimension ` +
        `(see GET /health) and re-index existing vectors.`,
    )
  }
  return 'cpu'
}

export class EmbeddingService {
  private modelName: string
  private extractor: FeatureExtractionPipeline | null = null
  private dimensions: number | null = null
  private device: EmbeddingConfig['device']
  private quantized: boolean
  private dtype?: EmbeddingConfig['dtype']

  constructor(private config: EmbeddingConfig) {
    this.modelName = config.model
    this.device = config.device
    this.quantized = config.quantized
    this.dtype = config.dtype
  }

  async load(): Promise<void> {
    const options: Record<string, unknown> = {
      device: this.device === 'wasm' ? 'cpu' : this.device,
      // v4: quantized flag removed → dtype. fp32 (BAAI/bge-m3 has no
      // q8 artifact) unless explicitly overridden.
      dtype: this.dtype || (this.quantized ? 'q8' : 'fp32'),
      // BAAI/bge-m3 ships weights as external data (model.onnx_data,
      // 2.1GB) but its config.json does not declare the format — without
      // this flag v4 silently skips onnx_data and session creation fails.
      use_external_data_format: true,
    }
    this.extractor = (await pipeline(
      'feature-extraction',
      this.modelName,
      options,
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

    this.dimensions = dimensions
    return { embeddings: allEmbeddings, dimensions }
  }

  getModelName(): string {
    return this.modelName
  }

  getDimensions(): number | null {
    // Real dimension once a batch has been embedded; null before first call.
    return this.dimensions
  }

  getDevice(): string {
    return this.device
  }

  getQuantized(): boolean {
    return this.quantized
  }

  getDtype(): EmbeddingConfig['dtype'] | undefined {
    return this.dtype
  }
}
