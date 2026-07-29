import { analyzerRegistry } from '../analyzer-registry.js'
import { labAnalyzer } from './lab.analyzer.js'

analyzerRegistry['application/pdf'] = labAnalyzer
