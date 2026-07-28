import type { PluginManifest } from './plugin-catalog.service.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

const ID_PATTERN = /^[a-z0-9]([a-z0-9._\-/]*[a-z0-9])?$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasString(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === 'string' && (obj[key] as string).trim().length > 0
}

export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = []

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['Manifest must be a JSON object'] }
  }

  if (!hasString(input, 'manifest_version')) {
    errors.push('manifest_version is required')
  }

  const plugin = input.plugin
  if (!isPlainObject(plugin)) {
    return { valid: false, errors: ['plugin object is required', ...errors] }
  }

  const requiredPluginFields = ['id', 'name', 'version', 'description', 'category']
  for (const field of requiredPluginFields) {
    if (!hasString(plugin, field)) {
      errors.push(`plugin.${field} is required`)
    }
  }

  if (typeof plugin.id === 'string') {
    if (!ID_PATTERN.test(plugin.id)) {
      errors.push('plugin.id must contain only alphanumeric characters, dots, dashes, underscores, or slashes')
    }
    if (plugin.id.includes('..')) {
      errors.push('plugin.id must not contain ".."')
    }
  }

  const author = plugin.author
  if (!isPlainObject(author) || !hasString(author, 'name')) {
    errors.push('plugin.author.name is required')
  }

  const runtime = input.runtime
  if (!isPlainObject(runtime)) {
    errors.push('runtime object is required')
  } else {
    const allowedRuntimes = ['container', 'wasm', 'process']
    if (!allowedRuntimes.includes(runtime.type as string)) {
      errors.push(`runtime.type must be one of: ${allowedRuntimes.join(', ')}`)
    }
    if (runtime.type === 'container' && !hasString(runtime, 'image')) {
      errors.push('runtime.image is required for container plugins')
    }
    if (runtime.type === 'wasm' && !hasString(runtime, 'module')) {
      errors.push('runtime.module is required for wasm plugins')
    }
    if (runtime.type === 'process' && !Array.isArray(runtime.command)) {
      errors.push('runtime.command array is required for process plugins')
    }
  }

  const tools = input.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push('tools must be a non-empty array')
  } else {
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]
      if (!isPlainObject(tool)) {
        errors.push(`tools[${i}] must be an object`)
        continue
      }
      if (!hasString(tool, 'name')) {
        errors.push(`tools[${i}].name is required`)
      }
      if (!hasString(tool, 'description')) {
        errors.push(`tools[${i}].description is required`)
      }
      if (!isPlainObject(tool.parameters)) {
        errors.push(`tools[${i}].parameters object is required`)
      }
    }
  }

  const triggers = input.triggers
  if (triggers !== undefined) {
    if (!Array.isArray(triggers)) {
      errors.push('triggers must be an array')
    } else {
      for (let i = 0; i < triggers.length; i++) {
        const t = triggers[i]
        if (!isPlainObject(t)) {
          errors.push(`triggers[${i}] must be an object`)
          continue
        }
        if (!hasString(t, 'intent')) {
          errors.push(`triggers[${i}].intent is required`)
        }
        if (!Array.isArray(t.patterns) || t.patterns.length === 0) {
          errors.push(`triggers[${i}].patterns must be a non-empty array`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
