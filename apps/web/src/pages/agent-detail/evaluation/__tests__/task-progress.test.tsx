/**
 * Covers what the task detail page shows *while a task is still executing* —
 * the state that previously rendered as an unexplained grey badge with no sign
 * of whether anything was happening.
 */
import type { EvaluationResultRow } from '@/hooks/use-evaluation'
import { renderWithProviders, screen } from '@/test/render'
import { describe, expect, it, vi } from 'vitest'
import { TaskDetail } from '../task-detail'

const useEvaluationTask = vi.fn()

vi.mock('@/hooks/use-evaluation', () => ({
  useEvaluationTask: (...args: unknown[]) => useEvaluationTask(...args),
  useReviewEvaluationResult: () => ({ mutate: vi.fn(), isPending: false }),
}))

function makeResult(overrides: Partial<EvaluationResultRow> = {}): EvaluationResultRow {
  return {
    id: 'evr_1',
    taskId: 'evt_1',
    caseId: 'evc_1',
    caseName: 'case one',
    status: 'completed',
    turnsSnapshot: [],
    actualTurns: [],
    review: null,
    error: null,
    durationMs: 10,
    sortOrder: 0,
    ...overrides,
  } as EvaluationResultRow
}

function renderTask(status: string, results: EvaluationResultRow[]) {
  useEvaluationTask.mockReturnValue({
    isLoading: false,
    data: {
      id: 'evt_1',
      agentId: 'agt_1',
      setName: 'Smoke set',
      name: 'Nightly run',
      status,
      configSnapshot: { providerName: 'Anthropic', model: 'claude-opus-4-8', systemPrompt: '' },
      summary: null,
      results,
    },
  })
  renderWithProviders(
    <TaskDetail agentId="agt_1" taskId="evt_1" canWrite onBack={() => undefined} />,
  )
}

describe('TaskDetail execution progress', () => {
  it('counts finished cases while the task is running', () => {
    renderTask('running', [
      makeResult({ id: 'evr_1', sortOrder: 0, status: 'completed' }),
      makeResult({ id: 'evr_2', sortOrder: 1, status: 'failed' }),
      makeResult({ id: 'evr_3', sortOrder: 2, status: 'running', caseName: 'case three' }),
      makeResult({ id: 'evr_4', sortOrder: 3, status: 'pending' }),
    ])

    // Execution progress, distinct from the "reviewed x/y" counter below it:
    // a failed case has still finished executing and counts toward the total.
    expect(screen.getByText('已完成 2/4')).toBeInTheDocument()
    expect(screen.getByText('当前：case three')).toBeInTheDocument()
  })

  it('explains the wait instead of showing an empty bar when queued', () => {
    renderTask('queued', [makeResult({ status: 'pending' })])

    expect(screen.getByText(/轮到时会自动开始/)).toBeInTheDocument()
    expect(screen.queryByText(/已完成 \d+\/\d+/)).not.toBeInTheDocument()
  })

  it('hides execution progress once the task has finished', () => {
    renderTask('completed', [makeResult({ status: 'completed' })])

    expect(screen.queryByText('已完成 1/1')).not.toBeInTheDocument()
  })

  it('keeps execution order while running so rows do not jump between polls', () => {
    renderTask('running', [
      makeResult({ id: 'evr_1', sortOrder: 0, caseName: 'first', status: 'completed' }),
      makeResult({ id: 'evr_2', sortOrder: 1, caseName: 'second', status: 'running' }),
    ])

    const names = screen.getAllByText(/^(first|second)$/).map((el) => el.textContent)
    expect(names).toEqual(['first', 'second'])
  })
})
