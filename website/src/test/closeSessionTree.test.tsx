/**
 * Closing a session tree — the plan, and the guard on the destructive case.
 *
 * The session tree's ✕ closes a card and the sessions nested under it, and a
 * cancelled turn cannot be restored. So the contract under test is narrow and
 * entirely about consent: a subtree with nothing running closes as quietly as a
 * single card always has, a subtree with running work asks first and names what it
 * would take down, and a cancelled ask closes NOTHING (#17253).
 *
 * The close itself is asserted through the `deleteSlot` thunk the hook dispatches —
 * including its ORDER, which is load-bearing: deepest first, so no parent is
 * archived while a child still cites it as a live creator.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'

const chatConfig = vi.hoisted(() => ({ confirmCloseSession: false }))
vi.mock('../pages/chat/ChatSettings', () => ({ loadChatConfig: () => chatConfig }))

/** A thunk whose dispatch returns the `{ unwrap }` shape the hook awaits. */
const deleteSlot = vi.hoisted(() => vi.fn((key: string) => () => ({
  unwrap: async () => key,
})))
vi.mock('../store/chatSlice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteSlot,
}))

import { store } from '../store'
import { planCloseTree, type CloseTreeRow } from '../lib/sessionCloseTree'
import { useCloseSessionTree } from '../hooks/useCloseSessionTree'

interface Row extends CloseTreeRow {
  key: string
  title?: string
  running?: boolean
}

const root = (key: string, title: string, running = false): Row =>
  ({ key, title, running, parent: null })
const child = (key: string, title: string, parent: string, running = false): Row =>
  ({ key, title, running, parent: { slot: parent, key: parent } })

const isRunning = (row: Row) => row.running === true

/** The closed keys in dispatch order. */
const closedOrder = () => deleteSlot.mock.calls.map(([key]) => key)

function Press({ rows }: { rows: Row[] }) {
  const { closeSessionTree, closeTreeDialog } = useCloseSessionTree({
    rows, isRunning, closeOne: (key: string) => closeOneSpy(key),
  })
  return (
    <>
      <button data-testid="x" onClick={() => closeSessionTree('lead')}>x</button>
      {closeTreeDialog}
    </>
  )
}

function Harness({ rows }: { rows: Row[] }) {
  return (
    <Provider store={store}>
      <Press rows={rows} />
    </Provider>
  )
}

let closeOneSpy = vi.fn()

/** lead ─ w1 (running) ─ sub1 (running) / sub2 ; w2 */
const RUNNING_TREE: Row[] = [
  root('lead', 'pipeline-conductor', true),
  child('w1', 'worker - babysit', 'lead', true),
  child('sub1', 'subworker - rerun lane', 'w1', true),
  child('sub2', 'subworker - log fetch', 'w1'),
  child('w2', 'worker - locale sweep', 'lead'),
]

/** The same shape with every descendant finished. */
const IDLE_TREE: Row[] = RUNNING_TREE.map(r => ({ ...r, running: r.key === 'lead' }))

beforeEach(() => {
  deleteSlot.mockClear()
  closeOneSpy = vi.fn()
  chatConfig.confirmCloseSession = false
})

describe('planCloseTree', () => {
  it('groups descendants by their depth below the pressed card', () => {
    const plan = planCloseTree(RUNNING_TREE, 'lead', isRunning)
    expect(plan.levels.map(l => [l.depth, l.sessions.map(s => s.key)])).toEqual([
      [0, ['lead']],
      [1, ['w1', 'w2']],
      [2, ['sub1', 'sub2']],
    ])
    expect(plan.total).toBe(5)
    expect(plan.descendantCount).toBe(4)
  })

  it('counts running DESCENDANTS only, and closes deepest first', () => {
    const plan = planCloseTree(RUNNING_TREE, 'lead', isRunning)
    // The pressed session is running too, and is deliberately not counted: its own
    // state never gated this press.
    expect(plan.runningDescendants).toBe(2)
    expect(plan.needsConfirm).toBe(true)
    expect(plan.order.indexOf('sub1')).toBeLessThan(plan.order.indexOf('w1'))
    expect(plan.order.indexOf('w1')).toBeLessThan(plan.order.indexOf('lead'))
    expect(plan.order.at(-1)).toBe('lead')
  })

  it('needs no confirm when every descendant has finished', () => {
    const plan = planCloseTree(IDLE_TREE, 'lead', isRunning)
    expect(plan.needsConfirm).toBe(false)
    expect(plan.runningDescendants).toBe(0)
    expect(plan.order).toHaveLength(5)
  })

  it('plans nothing for a key no longer on screen', () => {
    const plan = planCloseTree(RUNNING_TREE, 'gone', isRunning)
    expect(plan).toMatchObject({ total: 0, order: [], levels: [], needsConfirm: false })
  })

  it('titles a session by its key when it has none', () => {
    const plan = planCloseTree([{ key: 'lead', parent: null }], 'lead', () => false)
    expect(plan.levels[0].sessions[0].title).toBe('lead')
  })
})

describe('useCloseSessionTree', () => {
  it('delegates a card with no descendants to the existing single close', async () => {
    const user = userEvent.setup()
    render(<Harness rows={[root('lead', 'solo', true)]} />)
    await user.click(screen.getByTestId('x'))
    // Today's path owns a leaf card, preference prompt included.
    expect(closeOneSpy).toHaveBeenCalledWith('lead')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteSlot).not.toHaveBeenCalled()
  })

  it('closes a finished subtree with no dialog', async () => {
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closedOrder()).toEqual(['sub1', 'sub2', 'w1', 'w2', 'lead'])
    expect(closeOneSpy).not.toHaveBeenCalled()
  })

  it('asks before closing a subtree that is still running, listing the levels', async () => {
    const user = userEvent.setup()
    render(<Harness rows={RUNNING_TREE} />)
    await user.click(screen.getByTestId('x'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    // Nothing closes while the question is open.
    expect(deleteSlot).not.toHaveBeenCalled()

    // One block per sub-level, the pressed card's own level included.
    const levels = screen.getByTestId('close-tree-levels')
    expect(levels.querySelectorAll('[data-testid^="close-tree-level-"]')).toHaveLength(3)
    expect(screen.getByTestId('close-tree-level-0')).toHaveTextContent('This session')
    expect(screen.getByTestId('close-tree-level-1')).toHaveTextContent('Level 1')
    expect(screen.getByTestId('close-tree-level-2')).toHaveTextContent('Level 2')

    // Every session in the subtree is named, and the running ones are marked as
    // such — the two facts the dialog exists to carry.
    for (const row of RUNNING_TREE) {
      const entry = screen.getByTestId(`close-tree-session-${row.key}`)
      expect(entry).toHaveTextContent(row.title!)
      expect(entry).toHaveTextContent(row.running ? 'Running' : 'Finished')
    }
    // The count the user consents to is on the button, not just in the prose.
    expect(screen.getByRole('button', { name: 'Close all 5' })).toBeInTheDocument()
    expect(screen.getByText(/Still running below this session: 2 of 4/)).toBeInTheDocument()
  })

  it('closes nothing when the ask is cancelled', async () => {
    const user = userEvent.setup()
    render(<Harness rows={RUNNING_TREE} />)
    await user.click(screen.getByTestId('x'))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteSlot).not.toHaveBeenCalled()
    expect(closeOneSpy).not.toHaveBeenCalled()
  })

  it('closes the whole tree, deepest first, once the ask is confirmed', async () => {
    const user = userEvent.setup()
    render(<Harness rows={RUNNING_TREE} />)
    await user.click(screen.getByTestId('x'))
    await user.click(await screen.findByRole('button', { name: 'Close all 5' }))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(closedOrder()).toEqual(['sub1', 'sub2', 'w1', 'w2', 'lead'])
  })

  it('asks for a finished subtree too when the close-confirm preference is on', async () => {
    // A user who asked to be warned before losing ONE session is still warned
    // before losing five, which is what that preference means.
    chatConfig.confirmCloseSession = true
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Closing this session also closes everything nested under it: 4 more/))
      .toBeInTheDocument()
    expect(deleteSlot).not.toHaveBeenCalled()
  })
})
