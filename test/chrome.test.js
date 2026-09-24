import test from 'node:test'
import assert from 'node:assert/strict'
import { findChrome, launch, countPdfPages } from '../cli/chrome.js'

const chrome = findChrome()

test('countPdfPages counts Page objects, not the Pages tree', () => {
  const pdf = Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] >> << /Type /Page >> << /Type/Page/Parent 1 0 R >>')
  assert.equal(countPdfPages(pdf), 2)
  assert.equal(countPdfPages(Buffer.from('')), 0)
})

test('launch rejects when the executable does not exist', async () => {
  await assert.rejects(launch({ executable: '/nonexistent/recto-chrome' }))
})

test('drives headless Chrome over the DevTools pipe', { skip: !chrome && 'no Chrome/Chromium found' }, async () => {
  const browser = await launch()
  try {
    const page = await browser.newPage('data:text/html,<title>x</title><p>hi</p>')
    assert.equal(typeof page.sessionId, 'string')
    assert.equal(await page.evaluate('document.title'), 'x')
    assert.equal(await page.evaluate('Promise.resolve(2)'), 2)
    await assert.rejects(page.evaluate('nope()'), /nope/)
    const pdf = await page.pdf()
    assert.ok(Buffer.isBuffer(pdf))
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF')
    assert.equal(countPdfPages(pdf), 1)
    await page.close()
    await assert.rejects(browser.newPage('http://127.0.0.1:1/'), /Could not load .*net::ERR_/)
  } finally {
    await browser.close()
  }
})
