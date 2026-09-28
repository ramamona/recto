// Candidate profile dialog (review-jobs spec 3, discover-apply spec 3/5): feeds the Job tab's work-authorization and
// deal-breaker gates, and the applicant fields an application pack and `recto autoapply` fill in.
import { h, uid } from './dom.js'
import { dialogBox } from './topbar.js'
import { loadProfile, saveProfile, normalizeProfile, prefillProfile, REMOTE, APPLICANT_FIELDS, EEO_FIELDS } from '../profile.js'

const LISTS = ['authorizedIn', 'locations', 'targetRoles', 'dealBreakers']
const INPUT_TYPE = { email: 'email', phone: 'tel', linkedin: 'url', github: 'url', website: 'url' }
const RELOCATE = { '': null, yes: true, no: false }

export const splitList = s => String(s ?? '').split(/[,\n]/).map(v => v.trim()).filter(Boolean)

/** Raw form values (strings, checkbox boolean) → normalized profile; blanks stay unset. `eeo.<k>` and
 * `willingToRelocate` ('' | 'yes' | 'no') come from the applicant section. */
export function toProfile(values) {
  const out = { ...values }
  for (const k of LISTS) out[k] = splitList(values[k])
  if ('willingToRelocate' in values) out.willingToRelocate = RELOCATE[values.willingToRelocate] ?? null
  out.eeo = Object.fromEntries(EEO_FIELDS.map(k => [k, values[`eeo.${k}`]]))
  return normalizeProfile(out)
}

/** Opens the form; `doc` (the open CV) prefills empty name, email, phone and links; `onSave(profile)` runs after it is stored. */
export function openProfileDialog(ctx, { onSave, doc } = {}) {
  const { t } = ctx
  const p = prefillProfile(loadProfile(), doc)
  const field = (key, control, hint) => {
    control.id = uid('pf')
    control.name ||= key
    return h('div', { class: 'ai-field' }, h('label', { class: 'ui-label', htmlFor: control.id }, t(`profile.${key}`)), control,
      hint && h('p', { class: 'ui-muted ai-hint' }, t(`profile.${key}.hint`)))
  }
  const text = (key, hint = true) => field(key, h('input', { class: 'ui-input', type: 'text', value: (p[key] ?? []).join(', ') }), hint)
  const sponsor = h('input', { type: 'checkbox', checked: p.needsSponsorship, id: uid('pf'), name: 'needsSponsorship' })
  const remote = h('select', { class: 'ui-select' }, REMOTE.map(r => h('option', { value: r, selected: r === p.remote }, t(`profile.remote.${r}`))))
  const salary = h('input', { class: 'ui-input', type: 'number', min: 0, step: 1000, value: p.salaryMin ?? '' })
  const currency = h('input', { class: 'ui-input pf-currency', type: 'text', maxLength: 3, name: 'currency', value: p.currency ?? '', 'aria-label': t('profile.currency') })

  // ---------- applicant fields (discover-apply spec 3) ----------
  const input = (key, value, type = 'text', name = key) => h('input', { class: 'ui-input', type, name, value: value ?? '', autocomplete: 'off' })
  const applicant = key => field(`applicant.${key}`, input(key, p[key], INPUT_TYPE[key]))
  const relocate = field('applicant.willingToRelocate', h('select', { class: 'ui-select', name: 'willingToRelocate' },
    Object.entries(RELOCATE).map(([v, b]) => h('option', { value: v, selected: p.willingToRelocate === b }, t(`profile.applicant.relocate.${v || 'unset'}`)))))
  const eeo = k => field(`applicant.eeo.${k}`, input(k, p.eeo?.[k], 'text', `eeo.${k}`))

  const form = h('form', { class: 'ai-form pf-form', onSubmit: e => { e.preventDefault(); save() } },
    h('p', { class: 'ui-muted ai-hint' }, t('profile.intro')),
    text('authorizedIn'),
    h('label', { class: 'ai-row', htmlFor: sponsor.id }, sponsor, t('profile.needsSponsorship')),
    text('locations', false),
    field('remote', remote),
    text('targetRoles', false),
    text('dealBreakers'),
    h('div', { class: 'ai-row' }, field('salaryMin', salary), currency),
    h('fieldset', { class: 'pf-applicant' },
      h('legend', { class: 'pf-applicant__title' }, t('profile.applicant.title')),
      h('p', { class: 'ui-muted ai-hint' }, t('profile.applicant.intro')),
      h('div', { class: 'pf-grid' }, APPLICANT_FIELDS.map(applicant), field('applicant.pronouns', input('pronouns', p.pronouns)), relocate),
      h('p', { class: 'ui-muted ai-hint' }, t('profile.applicant.eeo.intro')),
      h('div', { class: 'pf-grid' }, EEO_FIELDS.map(eeo))))

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
