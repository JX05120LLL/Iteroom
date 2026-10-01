export interface ManagedTaskSelection {
  getSnapshot: () => string | null
  subscribe: (listener: () => void) => () => void
}

export function managedTaskSelection() {
  let id: string | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => id,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    select: (value: string) => {
      id = value
      for (const listener of listeners) listener()
    },
  }
}

export const emptyTaskSelection: ManagedTaskSelection = {
  getSnapshot: () => null,
  subscribe: () => () => {},
}
