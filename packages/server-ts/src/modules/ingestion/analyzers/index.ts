import { analyzerRegistry } from '../analyzer-registry.js'
import { labAnalyzer } from './lab.analyzer.js'
import { imagingAnalyzer } from './imaging.analyzer.js'
import { protocolAnalyzer } from './protocol.analyzer.js'

analyzerRegistry['application/pdf'] = labAnalyzer
analyzerRegistry['application/dicom'] = imagingAnalyzer
analyzerRegistry['image/jpeg'] = imagingAnalyzer
analyzerRegistry['image/png'] = imagingAnalyzer
analyzerRegistry['image/gif'] = imagingAnalyzer
analyzerRegistry['image/webp'] = imagingAnalyzer
analyzerRegistry['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] = protocolAnalyzer
analyzerRegistry['application/msword'] = protocolAnalyzer
