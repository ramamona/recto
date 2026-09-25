// Candidate profile dialog (review-jobs spec 3): feeds the Job tab's work-authorization and deal-breaker gates.
import { h, uid } from './dom.js'
import { dialogBox } from './topbar.js'
import { loadProfile, saveProfile, normalizeProfile, REMOTE } from '../profile.js'

const LISTS = ['authorizedIn', 'locations', 'targetRoles', 'dealBreakers']

export const splitList = s => String(s ?? '').split(/[,\n]/).map(v => v.trim()).filter(Boolean)

/** Raw form values (strings, checkbox boolean) → normalized profile; blanks stay unset. */
export function toProfile(values) {
  const out = { ...values }
  for (const k of LISTS) out[k] = splitList(values[k])
  return normalizeProfile(out)
}

/** Opens the form; `onSave(profile)` runs after it is stored. */
export function openProfileDialog(ctx, { onSave } = {}) {
  const { t } = ctx
  const p = loadProfile()
  const field = (key, control, hint) => {
    control.id = uid('pf')
    control.name = key
    return h('div', { class: 'ai-field' }, h('label', { class: 'ui-label', htmlFor: control.id }, t(`profile.${key}`)), control,
      hint && h('p', { class: 'ui-muted ai-hint' }, t(`profile.${key}.hint`)))
  }
  const text = (key, hint = true) => field(key, h('input', { class: 'ui-input', type: 'text', value: (p[key] ?? []).join(', ') }), hint)
  const sponsor = h('input', { type: 'checkbox', checked: p.needsSponsorship, id: uid('pf'), name: 'needsSponsorship' })
  const remote = h('select', { class: 'ui-select' }, REMOTE.map(r => h('option', { value: r, selected: r === p.remote }, t(`profile.remote.${r}`))))
  const salary = h('input', { class: 'ui-input', type: 'number', min: 0, step: 1000, value: p.salaryMin ?? '' })
  const currency = h('input', { class: 'ui-input pf-currency', type: 'text', maxLength: 3, name: 'currency', value: p.currency ?? '', 'aria-label': t('profile.currency') })
  const form = h('form', { class: 'ai-form pf-form', onSubmit: e => { e.preventDefault(); save() } },
    h('p', { class: 'ui-muted ai-hint' }, t('profile.intro')),
    text('authorizedIn'),
    h('label', { class: 'ai-row', htmlFor: sponsor.id }, sponsor, t('profile.needsSponsorship')),
    text('locations', false),
    field('remote', remote),
    text('targetRoles', false),
    text('dealBreakers'),
    h('div', { class: 'ai-row' }, field('salaryMin', salary), currency))

  let close
  function save() {
    const values = Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]))
    const saved = saveProfile(toProfile(values))
    close()
    ctx.toast?.(t('profile.saved'))
    onSave?.(saved)
  }
  const cancel = h('button', { class: 'ui-btn', type: 'button', onClick: () => close() }, t('app.cancel'))
  const ok = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', dataset: { action: 'profile-save' }, onClick: save }, t('profile.save'))
  close = ctx.openDialog(dialogBox(t('profile.title'), form, [cancel, ok]))
}
