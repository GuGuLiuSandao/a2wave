import {
  DefaultExecutionEventBusManager,
  type ExecutionEventBus,
  type ExecutionEventBusManager,
  type ServerCallContext,
} from '@a2a-js/sdk/server'

// Request handlers are intentionally short-lived because their executor carries
// request-specific audit and cancellation context. The event buses are not: a
// later CancelTask or SubscribeToTask request must attach to the bus created by
// the original SendMessage request.
const processEventBusManager = new DefaultExecutionEventBusManager()

export interface ScopedExecutionEventBusManager extends ExecutionEventBusManager {
  wasReused(taskId: string): boolean
}

class ProcessScopedExecutionEventBusManager implements ScopedExecutionEventBusManager {
  private readonly reusedTaskIds = new Set<string>()

  constructor(private readonly scopeKey: string) {}

  createOrGetByTaskId(taskId: string): ExecutionEventBus {
    if (processEventBusManager.getByTaskId(this.key(taskId))) {
      this.reusedTaskIds.add(taskId)
    }
    return processEventBusManager.createOrGetByTaskId(this.key(taskId))
  }

  getByTaskId(taskId: string): ExecutionEventBus | undefined {
    return processEventBusManager.getByTaskId(this.key(taskId))
  }

  cleanupByTaskId(taskId: string): void {
    processEventBusManager.cleanupByTaskId(this.key(taskId))
    this.reusedTaskIds.delete(taskId)
  }

  wasReused(taskId: string): boolean {
    return this.reusedTaskIds.has(taskId)
  }

  private key(taskId: string): string {
    return `${this.scopeKey.length}:${this.scopeKey}${taskId}`
  }
}

export function createScopedEventBusManager(
  context: ServerCallContext,
): ScopedExecutionEventBusManager {
  const tenant = context.tenant?.trim()
  const owner = context.user?.userName?.trim()
  if (!tenant || !owner) {
    throw new Error('A2A event bus access requires both tenant and caller scope')
  }
  return new ProcessScopedExecutionEventBusManager(JSON.stringify([tenant, owner]))
}
