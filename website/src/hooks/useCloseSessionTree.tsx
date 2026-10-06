import { useCallback, type ReactNode } from 'react'

import { useConfirm } from '../components/ConfirmDialog'
import { useAppDispatch } from '../store'
import { deleteSlot } from '../store/chatSlice'
import { loadChatConfig } from '../pages/chat/ChatSettings'
import { fmtNumber } from '../i18n/format'
import { i18nT } from '../i18n/t'
import { planCloseTree, type CloseTreePlan, type CloseTreeRow } from '../lib/sessionCloseTree'

/**
 * The session tree's ✕, as a close over the whole subtree with a guard on the one
 * case that destroys work in progress (#17253).
 *
 * The card's ✕ takes down the session AND the sessions nested under it, so one press
 * on a lead can end several workers' turns at once, with nothing to undo afterwards.
 * The guard is scoped to exactly that: a descendant still running earns the dialog,
 * and a subtree that has finished closes as quietly as a single card always has.
 *
 * The dialog is `useConfirm`, never `window.confirm` (CREW-20787 / #15976): the
 * native sheet is synchronous, unthemeable, cannot restate the action on its button,
 * and — decisively here — cannot list the sessions the press reaches, which is the
 * whole point of asking.
 */

/** The levels, rendered as the dialog's body. */
function CloseTreeBody({ plan }: { plan: CloseTreePlan }) {
  // Spans, not divs: `useConfirm` renders `body` inside a `<p>`, and a block-level
  // child there is invalid nesting React warns about. `block` carries the layout.
  return (
    <span className="block">
      <span className="block mb-3">
        {plan.runningDescendants > 0
          ? i18nT('hooks.useCloseSessionTree.body', {
            running: fmtNumber(plan.runningDescendants),
            descendants: fmtNumber(plan.descendantCount),
          })
          : i18nT('hooks.useCloseSessionTree.body_idle', {
            descendants: fmtNumber(plan.descendantCount),
          })}
      </span>
      <span
        className="block max-h-[40vh] overflow-y-auto rounded-lg border border-border bg-bg-elevated"
        data-testid="close-tree-levels"
      >
        {plan.levels.map(level => (
          <span
            key={level.depth}
            className="block px-2.5 py-1.5 border-b border-border last:border-b-0"
            data-testid={`close-tree-level-${level.depth}`}
          >
            <span className="block font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
              {level.depth === 0
                ? i18nT('hooks.useCloseSessionTree.level_self')
                : i18nT('hooks.useCloseSessionTree.level', { depth: fmtNumber(level.depth) })}
            </span>
            {level.sessions.map(session => (
              <span
                key={session.key}
                className="flex items-center gap-2 pt-0.5"
                data-testid={`close-tree-session-${session.key}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.running ? 'bg-[var(--warn)]' : 'bg-muted-strong'}`}
                  aria-hidden="true"
                />
                <span className="text-[12.5px] text-text truncate min-w-0">{session.title}</span>
                <span
                  className={`ml-auto shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                    session.running ? 'text-[var(--warn)]' : 'text-muted-strong'
                  }`}
                >
                  {i18nT(session.running
                    ? 'hooks.useCloseSessionTree.running'
                    : 'hooks.useCloseSessionTree.finished')}
                </span>
              </span>
            ))}
          </span>
        ))}
      </span>
    </span>
  )
}

export interface CloseSessionTreeOptions<R extends CloseTreeRow> {
  /** The rows currently on screen, in the lane's own order, keyed by slot key. */
  rows: readonly R[]
  /** The caller's own "still working" predicate — see `planCloseTree`. */
  isRunning: (row: R) => boolean
  /**
   * Today's single-session close, used verbatim for a card with no descendants.
   *
   * Delegated rather than reimplemented so a leaf card keeps the exact behaviour it
   * has now, including the `confirmCloseSession` preference's own prompt. Nothing
   * about a session with nothing under it changed in #17253.
   */
  closeOne: (key: string) => void
}

export interface CloseSessionTree {
  /** Close *key* and its subtree, asking first when that destroys running work. */
  closeSessionTree: (key: string) => void
  /** Render once in the owning component's JSX. */
  closeTreeDialog: ReactNode
}

export function useCloseSessionTree<R extends CloseTreeRow>(
  { rows, isRunning, closeOne }: CloseSessionTreeOptions<R>,
): CloseSessionTree {
  const dispatch = useAppDispatch()
  const { confirm, confirmDialog } = useConfirm()

  const closeSessionTree = useCallback((key: string) => {
    const plan = planCloseTree(rows, key, isRunning)
    // A press on a row that has since left the list closes nothing.
    if (plan.total === 0) return
    if (plan.descendantCount === 0) {
      closeOne(key)
      return
    }
    // Two reasons to ask. `needsConfirm` is the destructive case the issue is
    // about and is NOT preference-gated: running work is lost whatever the
    // setting says. The preference covers the rest, so a user who asked to be
    // warned before losing one session is still warned before losing six.
    const mustAsk = plan.needsConfirm || loadChatConfig().confirmCloseSession
    const run = async () => {
      if (mustAsk && !await confirm({
        title: i18nT('hooks.useCloseSessionTree.title'),
        body: <CloseTreeBody plan={plan} />,
        confirmLabel: i18nT('hooks.useCloseSessionTree.confirm', { number: fmtNumber(plan.total) }),
      })) return
      // The CONSENTED plan is what closes, deliberately not a re-plan: the dialog
      // is non-blocking, so the tree can have grown while it was open, and a
      // session the user was never shown must not be closed by their yes.
      //
      // Sequential, because `plan.order` is deepest-first and that ordering only
      // holds if each close completes before the next begins. A failed close
      // (the endpoint refuses while a guarded history write runs) leaves that
      // session open and does not abort the rest — the same visible, retryable
      // end state as pressing ✕ on that one card.
      for (const slot of plan.order) {
        await dispatch(deleteSlot(slot)).unwrap().catch(() => undefined)
      }
    }
    void run()
  }, [rows, isRunning, closeOne, confirm, dispatch])

  return { closeSessionTree, closeTreeDialog: confirmDialog }
}
