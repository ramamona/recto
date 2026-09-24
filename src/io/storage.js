// Browser persistence (spec 7): documents in localStorage, font blobs in IndexedDB, photo downscale.
// The document adapter takes a localStorage-like object, so its logic is Node-testable.

const INDEX = 'recto:index'
const DOC = 'recto:doc:'

const isQuota = e => e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e?.code === 22

function defaultLs() {
  try { return globalThis.localStorage ?? null } catch { return null } // throws when site data is blocked
}

/** StorageAdapter over localStorage: `recto:index` → [{ id, name, updatedAt }] newest first, `recto:doc:<id>` → container. */
export function createBrowserStorage(ls = defaultLs()) {
  const read = key => { try { return JSON.parse(ls.getItem(key)) } catch { return null } }
  const index = () => {
    const v = read(INDEX)
    return Array.isArray(v) ? v.filter(d => typeof d?.id === 'string') : []
  }
  const writeIndex = list => ls.setItem(INDEX, JSON.stringify(list))
  return {
    listDocs: index,
    loadDoc(id) {
      const v = read(DOC + id)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    },
    saveDoc(id, container) {
      try {
        const { fonts, ...rest } = container // fonts never live in localStorage
        ls.setItem(DOC + id, JSON.stringify(rest))
        writeIndex([{ id, name: rest.name ?? '', updatedAt: Date.now() }, ...index().filter(d => d.id !== id)])
        return { ok: true }
      } catch (e) {
        return { ok: false, error: isQuota(e) ? 'quota' : 'unknown' }
      }
    },
    deleteDoc(id) {
      try {
        ls.removeItem(DOC + id)
        writeIndex(index().filter(d => d.id !== id))
      } catch { /* nothing to delete */ }
    },
    onExternalChange(fn) {
      if (typeof addEventListener !== 'function') return () => {}
      const onStorage = e => { if (e.storageArea === ls && e.key?.startsWith(DOC)) fn(e.key.slice(DOC.length)) }
      addEventListener('storage', onStorage)
      return () => removeEventListener('storage', onStorage)
    },
  }
}

export function createMemoryStorage() {
  const m = new Map()
  const ls = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
  return { ...createBrowserStorage(ls), onExternalChange: () => () => {} }
}

// IndexedDB `recto` / `fonts`, keyed by family: { family, blob }
function fontStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('recto', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('fonts', { keyPath: 'family' })
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('fonts', mode)
      const req = fn(tx.objectStore('fonts'))
      tx.oncomplete = () => { db.close(); resolve(req.result) }
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}

export const saveFont = (family, blob) => fontStore('readwrite', s => s.put({ family, blob }))
export const deleteFont = family => fontStore('readwrite', s => s.delete(family))
export function loadFonts() {
  if (typeof indexedDB === 'undefined') return Promise.resolve([])
  return fontStore('readonly', s => s.getAll()).catch(() => [])
}

/** Load each font and add it to document.fonts; failures are skipped. Resolves the loaded families. */
export async function registerFonts(list) {
  const loaded = await Promise.all(list.map(async ({ family, blob }) => {
    try {
      const face = new FontFace(family, await blob.arrayBuffer())
      document.fonts.add(await face.load())
      return family
    } catch { return null }
  }))
  return loaded.filter(Boolean)
}

const PHOTO_SIDE = 400
const PHOTO_MAX_URL = 200000 // ≈150 KB of JPEG as base64; also normalizeLayout's cap for header.photo.src

export async function downscalePhoto(file) {
  const img = await createImageBitmap(file)
  const k = Math.min(1, PHOTO_SIDE / Math.max(img.width, img.height))
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.max(1, Math.round(img.width * k)), height: Math.max(1, Math.round(img.height * k)),
  })
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // JPEG has no alpha: transparent pixels would turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  img.close()
  const url = canvas.toDataURL('image/jpeg', 0.85)
  if (url.length > PHOTO_MAX_URL) throw new Error('photo-too-large')
  return url
}

let persistence
export function requestPersistence() {
  persistence ??= Promise.resolve(globalThis.navigator?.storage?.persist?.()).catch(() => false)
  return persistence
}
