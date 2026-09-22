
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
    // 'in-process': the tool runs inside the control plane (BioScene/chart
    // deterministic SVG renderers) — no container/wasm/process required.
    const allowedRuntimes = ['container', 'wasm', 'process', 'in-process']
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

  // #中-12: permissions 此前只被解析不校验（声明形同虚设）。现在按已知
  // 能力键做 fail-closed 形状校验：未知键/类型错误在安装（validate-manifest
  // / installPluginFromUrl）即拒绝，声明不再被静默忽略。运行面能力仍由
  // worker 沙箱/服务端注入 port 强制（见 PLUGIN_MANIFEST_SPEC §5）。
  const permissions = input.permissions
  if (permissions !== undefined) {
    if (!isPlainObject(permissions)) {
      errors.push('permissions must be an object')
    } else {
      const allowedPermissionKeys = ['network_egress', 'file_system', 'phi_access', 'execute_code']
      for (const key of Object.keys(permissions)) {
        if (!allowedPermissionKeys.includes(key)) {
          errors.push(`permissions.${key} is not a recognized capability (allowed: ${allowedPermissionKeys.join(', ')})`)
        }
      }
      const network = permissions.network_egress
      if (network !== undefined) {
        if (!isPlainObject(network) || typeof network.enabled !== 'boolean') {
          errors.push('permissions.network_egress.enabled must be a boolean')
        } else if (network.description !== undefined && typeof network.description !== 'string') {
          errors.push('permissions.network_egress.description must be a string')
        }
      }
      const fileSystem = permissions.file_system
      if (fileSystem !== undefined) {
        if (!isPlainObject(fileSystem) || typeof fileSystem.read !== 'boolean' || typeof fileSystem.write !== 'boolean') {
          errors.push('permissions.file_system.read/write must be booleans')
        } else if (fileSystem.paths !== undefined
          && (!Array.isArray(fileSystem.paths) || !fileSystem.paths.every((p) => typeof p === 'string'))) {
          errors.push('permissions.file_system.paths must be an array of strings')
        }
      }
      if (permissions.phi_access !== undefined && typeof permissions.phi_access !== 'boolean') {
        errors.push('permissions.phi_access must be a boolean')
      }
      if (permissions.execute_code !== undefined && typeof permissions.execute_code !== 'boolean') {
        errors.push('permissions.execute_code must be a boolean')
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
