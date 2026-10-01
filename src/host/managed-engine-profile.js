import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskEntryError } from './managed-task-store.js'

const pluginPath = fileURLToPath(new URL('./managed-engine-plugin.js', import.meta.url))
const modifyPluginPath = fileURLToPath(new URL('./managed-modify-plugin.js', import.meta.url))
const reviewPluginPath = fileURLToPath(new URL('./managed-review-plugin.js', import.meta.url))
export const DISABLED_HOST_ROWS = ['sandbox', 'sandbox-policy', 'subprocess', 'pty',
  'terminal-bash', 'terminal-pwsh', 'jobs', 'persistent-bash', 'persistent-pwsh', 'llm-retry', 'llm-deepseek']

/** An ordered CLI patch for one task. No user source or credentials are serialized into it. */
export function managedEnginePatch({ dataHome, projectRoot, taskId, mockAdapterPath } = {}) {
  if (!isAbsolute(dataHome ?? '') || !isAbsolute(projectRoot ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(taskId ?? '')
    || mockAdapterPath !== undefined && !isAbsolute(mockAdapterPath)) {
    throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
  }
  return DISABLED_HOST_ROWS.map(id => `- id: ${id}\n  disabled: true`).join('\n')
    + '\n- id: tools\n  config:\n    mode: native\n'
    + '\n- insert:\n    - id: iteroom-managed-engine\n'
    + `      name: ${JSON.stringify(pluginPath)}\n`
    + '      config:\n'
    + `        dataHome: ${JSON.stringify(dataHome)}\n`
    + `        projectRoot: ${JSON.stringify(projectRoot)}\n`
    + `        taskId: ${JSON.stringify(taskId)}\n`
    + (mockAdapterPath ? '        synthetic: true\n' : '')
    + (mockAdapterPath ? `    - id: iteroom-managed-engine-mock\n      name: ${JSON.stringify(mockAdapterPath)}\n` : '')
}

export function managedModifyPatch({ dataHome, projectRoot, taskId, sandboxId, mockAdapterPath } = {}) {
  if (!isAbsolute(dataHome ?? '') || !isAbsolute(projectRoot ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(taskId ?? '')
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(sandboxId ?? '')
    || mockAdapterPath !== undefined && !isAbsolute(mockAdapterPath)) {
    throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
  }
  return DISABLED_HOST_ROWS.map(id => `- id: ${id}\n  disabled: true`).join('\n')
    + '\n- id: tools\n  config:\n    mode: native\n'
    + '\n- insert:\n    - id: iteroom-managed-modify-engine\n'
    + `      name: ${JSON.stringify(modifyPluginPath)}\n`
    + '      config:\n'
    + `        dataHome: ${JSON.stringify(dataHome)}\n`
    + `        projectRoot: ${JSON.stringify(projectRoot)}\n`
    + `        taskId: ${JSON.stringify(taskId)}\n`
    + `        sandboxId: ${JSON.stringify(sandboxId)}\n`
    + '        modify: true\n'
    + (mockAdapterPath ? '        synthetic: true\n' : '')
    + (mockAdapterPath ? `    - id: iteroom-managed-modify-engine-mock\n      name: ${JSON.stringify(mockAdapterPath)}\n` : '')
}

export function managedReviewPatch(options = {}) {
  return managedEnginePatch(options).replace(JSON.stringify(pluginPath), JSON.stringify(reviewPluginPath))
}
