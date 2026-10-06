import { useMemo, useState } from 'react'
import { Forward, Plus } from 'lucide-react'

import { useAppDispatch, useAppSelector } from '../store'
import { createSlot } from '../store/chatSlice'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu'
import HoverTip from './HoverTip'
import { prepareCurrentSlots, isEmptyNewSlot } from './commandPalette/providers/recentsProvider'
import { loadDrafts, mergeIntoDraft } from '../utils/chatDrafts'
import type { NavIntent } from '../utils/popoutController'
import type { ChatSlot } from '../types'
import { i18nT } from '../i18n/t'
import { errMessage } from '../utils/thunkError'
import { Btn } from './ui'
import { artifactReferencePrompt } from './artifactReference.prompt'

/** How many live sessions the menu lists. The menu is a quick hand-off, not a
 *  session browser — the sidebar and the command palette own the long tail. */
const MAX_LISTED_SESSIONS = 10


/**
 * Toolbar control on the artifact page: drop a reference to this artifact into
 * a chat session's composer — an existing live session or a new one — so the
 * agent there can load it. The composer is only PRE-FILLED (the user still
 * presses send), and the reference is appended to that session's stored draft
 * rather than replacing it: the prefill consumer overwrites the composer, so an
 * unmerged seed would silently destroy text the user had typed there.
 */
export function ArtifactSendToSession({ name, slug, onSend, beforeSend, onError, className }: {
  name: string
  slug: string
  /** The page's navigation dispatcher, so a popout window forwards the
   *  hand-off to the main dashboard instead of navigating in place. */
  onSend: (intent: NavIntent) => void
  /** Runs the hand-off only once the page agrees to leave (e.g. the unsaved
   *  comment-draft prompt). It wraps session CREATION too, so cancelling the
   *  prompt never leaves an empty session nothing opens. */
  beforeSend: (proceed: () => void | Promise<void>) => void
  /** Failure text for the page's ErrorNotice stack, or `null` to clear it. */
  onError: (message: string | null) => void
  className?: string
}) {
  const dispatch = useAppDispatch()
  const slots = useAppSelector((s) => s.dashboard.slots)
  const [creating, setCreating] = useState(false)

  // Live sessions, most recent first. Sessions bound to an artifact are that
  // artifact's companion chat (this page's own lives behind the chat toggle),
  // and an empty placeholder is what "New session" already creates.
  const listed = useMemo(() => {
    const candidates = (slots ?? []).filter((s: ChatSlot) => !s.artifact && !isEmptyNewSlot(s))
    return prepareCurrentSlots(candidates).ordered.slice(0, MAX_LISTED_SESSIONS)
  }, [slots])

  const prompt = artifactReferencePrompt(name, slug)
  const handOff = (slotKey: string) => {
    const merged = mergeIntoDraft(loadDrafts()[slotKey], prompt)
    onSend({ path: '/chat', slotKey, prefill: { slotKey, prompt: merged } })
  }
  const handOffToNew = async () => {
    setCreating(true)
    onError(null)
    try {
      const slot = await dispatch(createSlot({ activate: false })).unwrap()
      handOff(slot.key)
    } catch (e) {
      onError(errMessage(e) || i18nT('components.errorBoundary.something_went_wrong'))
    } finally {
      setCreating(false)
    }
  }

  const label = i18nT('pages.artifactDetailPage.send_to_session')
  return (
    <DropdownMenu>
      <HoverTip label={label}>
        <DropdownMenuTrigger asChild>
          <Btn
            type="button"
            disabled={creating}
            className={className ?? 'p-1.5 rounded-md border border-border text-muted hover:text-text hover:border-border-strong cursor-pointer transition-all'}
            aria-label={label}
          >
            <Forward size={13} />
          </Btn>
        </DropdownMenuTrigger>
      </HoverTip>
      <DropdownMenuContent align="end" className="min-w-[220px] max-w-[320px] max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))]">
        <DropdownMenuItem onSelect={() => beforeSend(handOffToNew)}>
          <Plus size={13} aria-hidden="true" />
          {i18nT('pages.artifactDetailPage.send_to_new_session')}
        </DropdownMenuItem>
        {listed.length > 0 && <DropdownMenuSeparator />}
        {listed.map((s) => (
          <DropdownMenuItem key={s.key} onSelect={() => beforeSend(() => handOff(s.key))}>
            <span className="truncate">{s.title || i18nT('pages.artifactDetailPage.untitled_session')}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
