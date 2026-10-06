/**
 * Screenshot harness, and behaviour check, for the close-tree confirm (#17253).
 *
 * This ASSERTS as well as photographs. The unit tests pin the plan and the dialog's
 * contents in happy-dom, but a reviewer judging a guardrail wants to see the real
 * prompt over the real tree — and a blank or wrong frame has to FAIL here rather
 * than ship as evidence, so every beat is checked and a bad run exits non-zero.
 *
 * Beats:
 *   1. the conductor lane, tree expanded, nothing asked          tree.png
 *   2. ✕ on the lead with three sessions mid-turn -> the prompt   confirm.png
 *   3. Cancel -> the tree is still there, nothing closed          cancelled.png
 *   4. ✕ again, confirm -> the whole subtree is gone              closed.png
 *   5. ✕ on a card with nothing under it -> no prompt            (assertion only)
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 6186 --strictPort      # in another shell
 *   node scripts/capture-close-session-tree.mjs http://127.0.0.1:6186 [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { chromiumExecutable } from './lib/chromium-executable.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:6186'
const OUT = process.argv[3] || '../temp-screenshots/close-session-tree'
const LEAD = 'chat-lead'
const SOLO = 'chat-solo'
const SUBTREE = ['chat-babysit', 'chat-rerun', 'chat-logs', 'chat-locale']

mkdirSync(OUT, { recursive: true })

let failed = false
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
// Wide enough that the sidebar renders its DESKTOP row cluster: below the mobile
// breakpoint a row drops the hover ✕ for a single ⋯ menu, and the subject here is
// the ✕ itself.
const context = await browser.newContext({ viewport: { width: 1040, height: 780 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', e => { console.log(`FAIL pageerror — ${e.message}`); failed = true })

/** Every DELETE the close path sends, in order — the behaviour under the frame. */
const deleted = []
await stubDashboardApi(page, {
  theme: 'dark',
  folders: [],
  extra: async (path, route) => {
    if (route.request().method() === 'DELETE' && path.startsWith('/api/chat/slots/')) {
      deleted.push(decodeURIComponent(path.slice('/api/chat/slots/'.length)))
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return true
    }
    // The dev server serves source modules by their own path, and the stub's
    // `**/api/**` pattern also matches `/src/api/client.ts`; answering that with
    // JSON where the browser requires JavaScript means the page never mounts.
    if (path.startsWith('/api/')) return false
    await route.continue()
    return true
  },
})
logPageProblems(page)

/** The sidebar panel alone — the frames whose subject is the lane, not the prompt
 *  centred over the whole window. */
const PANEL = { x: 0, y: 0, width: 540, height: 780 }

const rowKeys = () => page.$$eval('[data-slot-key]', els => els.map(el => el.getAttribute('data-slot-key')))
const dialog = () => page.locator('[role="dialog"]')

/** Press the ✕ on one row. It is a reveal-on-hover control, so hover first. */
async function pressClose(key) {
  const row = page.locator(`[data-slot-key="${key}"]`).first()
  await row.hover()
  await row.locator('[aria-label="Close session"]').first().click()
}

await page.goto(`${BASE}/capture/close-session-tree.html?theme=dark`)
await page.waitForSelector('[data-capture-ready]')
await page.waitForSelector(`[data-slot-key="${LEAD}"]`)
await page.waitForTimeout(400)

// ── 1. the tree, before anything is asked ─────────────────────────────────────
const before = await rowKeys()
check('the lane nests the whole subtree under the lead',
  SUBTREE.every(k => before.includes(k)), before.join(', '))
await page.screenshot({ path: `${OUT}/tree.png`, clip: PANEL })

// ── 2. the press, and the prompt it raises ────────────────────────────────────
await pressClose(LEAD)
await dialog().waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(350)
check('nothing closed while the question is open', deleted.length === 0, deleted.join(', '))

// Read the body once it is mounted, not merely once the shell is: the title paints
// a frame before the level list, and the earlier read passed on the title alone.
await page.locator('[data-testid="close-tree-levels"]').waitFor({ state: 'visible', timeout: 5000 })
// `innerText` applies `text-transform`, so the level headings come back upper-cased —
// compared case-insensitively rather than against the catalog's own casing.
const text = await dialog().innerText()
const says = needle => text.toLowerCase().includes(needle.toLowerCase())
// Two of the four DESCENDANTS are mid-turn. The lead is running too and is
// deliberately not counted: its own state never gated this press.
check('the prompt names the running descendants', /2 of 4/.test(text), text.split('\n')[1])
for (const level of ['This session', 'Level 1', 'Level 2']) {
  check(`the prompt lists ${level}`, says(level))
}
// Read the MARK off each session's own row, not off the dialog's whole text: the
// body prose says "running" too, so a text-wide count is one too many.
const marks = await page.$$eval('[data-testid^="close-tree-session-"]', els => Object.fromEntries(
  els.map(el => [el.getAttribute('data-testid').replace('close-tree-session-', ''), el.innerText.trim()]),
))
const marked = (key, word) => (marks[key] || '').toLowerCase().endsWith(word)
check('the prompt marks the sessions that are mid-turn',
  ['chat-lead', 'chat-babysit', 'chat-rerun'].every(k => marked(k, 'running')), JSON.stringify(marks))
check('the prompt marks the ones that have finished',
  ['chat-logs', 'chat-locale'].every(k => marked(k, 'finished')), JSON.stringify(marks))
check('the prompt names every session in the subtree',
  Object.keys(marks).length === 5, Object.keys(marks).join(', '))
check('the confirm button restates the action with its count',
  await page.getByRole('button', { name: 'Close all 5' }).isVisible())
await page.screenshot({ path: `${OUT}/confirm.png` })

// ── 3. Cancel closes nothing ──────────────────────────────────────────────────
await page.getByRole('button', { name: 'Cancel' }).click()
await dialog().waitFor({ state: 'hidden', timeout: 5000 })
await page.waitForTimeout(350)
check('cancel closed nothing', deleted.length === 0, deleted.join(', '))
const afterCancel = await rowKeys()
check('cancel left every row on screen',
  [LEAD, ...SUBTREE].every(k => afterCancel.includes(k)), afterCancel.join(', '))
await page.screenshot({ path: `${OUT}/cancelled.png`, clip: PANEL })

// ── 4. confirm closes the whole subtree, deepest first ────────────────────────
await pressClose(LEAD)
await dialog().waitFor({ state: 'visible', timeout: 5000 })
await page.getByRole('button', { name: 'Close all 5' }).click()
await page.waitForFunction(() => !document.querySelector('[data-slot-key="chat-lead"]'), null, { timeout: 8000 })
await page.waitForTimeout(400)
check('every session in the tree was closed', deleted.length === 5, deleted.join(', '))
check('the lead was closed LAST, after everything under it',
  deleted.at(-1) === LEAD, deleted.join(' -> '))
check('a child was closed before its own parent',
  deleted.indexOf('chat-rerun') < deleted.indexOf('chat-babysit'), deleted.join(' -> '))
const afterClose = await rowKeys()
check('the subtree left the lane',
  [LEAD, ...SUBTREE].every(k => !afterClose.includes(k)), afterClose.join(', '))
check('an unrelated session is untouched', afterClose.includes(SOLO), afterClose.join(', '))
await page.screenshot({ path: `${OUT}/closed.png`, clip: PANEL })

// ── 5. a card with nothing under it still closes without a prompt ─────────────
deleted.length = 0
await pressClose(SOLO)
await page.waitForTimeout(600)
check('a leaf card raises no prompt', await dialog().count() === 0)
check('a leaf card closed anyway', deleted.length === 1 && deleted[0] === SOLO, deleted.join(', '))

await context.close()
await browser.close()
console.log(failed ? '\nFAILED' : `\nOK — frames in ${OUT}`)
process.exit(failed ? 1 : 0)
