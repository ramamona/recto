// File I/O (spec 7): File System Access in Chromium, <input type=file> and download elsewhere.

export const canUseFileSystemAccess = () =>
  typeof globalThis.showOpenFilePicker === 'function' && typeof globalThis.showSaveFilePicker === 'function'

const isAbort = e => e?.name === 'AbortError'

export const readFileText = file => file.text()

/** `accept` is an <input accept> list of extensions, e.g. '.json,.md'. Resolves null when cancelled. */
export async function openFile({ accept = '' } = {}) {
  if (canUseFileSystemAccess()) {
    const exts = accept.split(',').map(s => s.trim()).filter(Boolean)
    let handle
    try {
      [handle] = await showOpenFilePicker(exts.length ? { types: [{ description: 'CV', accept: { 'text/plain': exts } }] } : {})
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
    const file = await handle.getFile()
    return { name: file.name, text: await readFileText(file), handle }
  }
  const file = await pickFile(accept)
  return file && { name: file.name, text: await readFileText(file), handle: null }
}

// ponytail: a browser without the input 'cancel' event leaves this pending on cancel; harmless, nothing awaits it after.
function pickFile(accept) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept })
    input.addEventListener('change', () => resolve(input.files[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

const CV_TYPES = [{ description: 'Recto CV', accept: { 'application/json': ['.json'] } }]

/** Write a `.cv.json` to `handle`, a picked file, or a download. Resolves null when the picker is cancelled. */
export async function saveFile({ suggestedName, text, handle = null }) {
  if (!handle && canUseFileSystemAccess()) {
    try {
      handle = await showSaveFilePicker({ suggestedName, types: CV_TYPES })
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  if (!handle) {
    download(suggestedName, text, 'application/json')
    return { handle: null, name: suggestedName }
  }
  const w = await handle.createWritable()
  await w.write(text)
  await w.close()
  return { handle, name: handle.name }
}

export function download(name, data, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000) // revoking at once can cancel the download
}

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** [{ family, blob }] → [{ family, data: base64 }] for the `fonts` of a saved file. */
export const fontsToBase64 = list => Promise.all(list.map(async ({ family, blob }) =>
  ({ family, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) })))

export function base64ToBlob(b64, type = '') {
  let bin = ''
  try { bin = atob(b64) } catch { /* corrupt data → empty blob; the font then fails to load and is skipped */ }
  return new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))], { type })
}
