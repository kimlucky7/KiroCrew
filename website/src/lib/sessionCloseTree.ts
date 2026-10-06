/**
 * Closing a session tree — what the close would take down, as a pure function.
 *
 * The session tree's ✕ closes a card and the sessions nested under it. A lead with
 * three workers, each with sub-workers, is one card over seven sessions, and the
 * press is unrecoverable: an in-flight turn is cancelled and its partial work is
 * discarded. So before anything closes, the UI has to be able to say what the press
 * reaches and how much of it is still working (#17253).
 *
 * This module answers exactly that and does nothing else: no React, no store, no
 * I/O, no `deleteSlot`. The dialog copy and the close loop both read the same plan,
 * so the list a user consents to cannot differ from the sessions that are closed.
 *
 * KEY SPACE. Plans are built and returned in RAW slot-key space — the space
 * `deleteSlot` takes — not in the sidebar's origin-qualified row identities. A
 * federated peer row has no local slot to close, so it is not plannable from here
 * and callers pass their local rows.
 */

import { buildLineage, descendantsOf, type LineageRow } from './sessionLineage'

/** One session in the plan, as the dialog renders it. */
export interface CloseTreeSession {
  key: string
  /** The row's own title, or its key when it has none — never empty. */
  title: string
  running: boolean
}

/**
 * One sub-level of the tree. `depth` is RELATIVE to the session being closed: 0 is
 * that session itself, 1 its direct children, and so on. Relative, because the
 * dialog describes one press on one card, and the card's own absolute depth in the
 * sidebar is not a fact about what this press does.
 */
export interface CloseTreeLevel {
  depth: number
  sessions: CloseTreeSession[]
  runningCount: number
}

export interface CloseTreePlan {
  /**
   * Every key this close takes down, DEEPEST FIRST with the pressed session last.
   *
   * The order is load-bearing, not cosmetic: a parent archived while a child still
   * cites it as a live creator leaves the child re-rendered as an orphan mid-close,
   * and the backend's own close path reads the parent edge. Closing upward means
   * each session is closed only once nothing under it is still open.
   */
  order: string[]
  /** Level 0 (the session itself) first. Empty only for an unknown key. */
  levels: CloseTreeLevel[]
  /** `order.length` — the session plus its descendants. */
  total: number
  /** Sessions under the pressed one. `total - 1`, or 0 for an unknown key. */
  descendantCount: number
  /** How many DESCENDANTS are still running. The pressed session is excluded: its
   *  own running state never gated this press and must not start to. */
  runningDescendants: number
  /**
   * True when a descendant is still running, which is the destructive case the
   * confirm exists for. A caller may confirm on more than this (the
   * `confirmCloseSession` preference) but must never close a `true` plan silently.
   */
  needsConfirm: boolean
}

const EMPTY_PLAN: CloseTreePlan = {
  order: [], levels: [], total: 0, descendantCount: 0, runningDescendants: 0, needsConfirm: false,
}

/** A row this module can plan over: a lineage edge, and a title to show. */
export type CloseTreeRow = LineageRow & { title?: string }

/**
 * What closing *key* takes down, given the rows currently on screen.
 *
 * `isRunning` is the CALLER's predicate on purpose. The sidebar's notion of running
 * is wider than the payload's `slot.running` — a live workflow run or an armed goal
 * loop counts — and the dialog has to mark exactly the rows the lane draws as
 * running, or it would contradict the tree it is covering.
 *
 * An unknown key yields the empty plan rather than a throw: a stale press (the row
 * went away while the pointer was over it) must close nothing, not crash the sidebar.
 */
export function planCloseTree<R extends CloseTreeRow>(
  rows: readonly R[],
  key: string,
  isRunning: (row: R) => boolean,
): CloseTreePlan {
  const byKey = new Map<string, R>()
  for (const row of rows) if (row.key) byKey.set(row.key, row)
  const root = byKey.get(key)
  if (!root) return EMPTY_PLAN

  // The same lineage the lane nests by, so the plan cannot place a session
  // somewhere the user does not see it. `buildLineage` already refuses cycles and
  // parents absent from the payload, so the worst a strange payload yields is a
  // flatter plan.
  const { children, depth } = buildLineage(rows)
  const rootDepth = depth.get(key) ?? 0

  const session = (row: R): CloseTreeSession => ({
    key: row.key,
    title: row.title?.trim() || row.key,
    running: isRunning(row),
  })

  const byLevel = new Map<number, CloseTreeSession[]>([[0, [session(root)]]])
  let runningDescendants = 0
  // Walked over `rows`, not over `descendantsOf`'s own return: that one is a
  // stack-order DFS, so siblings come back reversed. Taking the input order means
  // the dialog lists siblings exactly as the lane above it does.
  const inSubtree = new Set(descendantsOf(key, children))
  for (const row of rows) {
    const childKey = row.key
    if (!inSubtree.has(childKey)) continue
    const entry = session(row)
    if (entry.running) runningDescendants += 1
    // Relative to the pressed card. Clamped at 1: a payload that somehow placed a
    // descendant no deeper than its root still belongs on a sub-level, never back
    // on level 0 beside the session being closed.
    const level = Math.max(1, (depth.get(childKey) ?? rootDepth + 1) - rootDepth)
    const bucket = byLevel.get(level)
    if (bucket) bucket.push(entry)
    else byLevel.set(level, [entry])
  }

  const levels: CloseTreeLevel[] = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([levelDepth, sessions]) => ({
      depth: levelDepth,
      sessions,
      runningCount: sessions.filter(s => s.running).length,
    }))

  // Deepest level first, the pressed session last. Within a level the lane's own
  // order is kept, so the dialog lists siblings the way the sidebar does.
  const order = [...levels].reverse().flatMap(level => level.sessions.map(s => s.key))
  return {
    order,
    levels,
    total: order.length,
    descendantCount: order.length - 1,
    runningDescendants,
    needsConfirm: runningDescendants > 0,
  }
}
