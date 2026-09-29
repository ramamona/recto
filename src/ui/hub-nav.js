// Primary navigation: the same strip in the top bar and in every full-screen view, so the job-search tools are
// one click from anywhere. ctx.navigate(view) (main.js) closes the open view and opens the next one.
import { h } from './dom.js'

export const HUB = ['cv', 'discover', 'pipeline', 'jobs', 'insights', 'profile']

/** `current`: the view this strip sits in; `beforeLeave()` runs before switching away (the profile saves itself). */
export function hubNav(ctx, current, { beforeLeave } = {}) {
  return h('nav', { class: 'hub-nav', 'aria-label': ctx.t('nav.label') }, HUB.map(view => h('button', {
    class: `hub-nav__item${view === current ? ' is-current' : ''}`, type: 'button',
    dataset: { action: view === 'cv' ? 'nav-cv' : view }, 'aria-current': view === current ? 'page' : null,
    onClick: () => {
      if (view === current) return
      beforeLeave?.()
      ctx.navigate?.(view)
    }
  }, ctx.t(`nav.${view}`))))
}
