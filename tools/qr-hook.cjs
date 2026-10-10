// Preloaded into the Zeus CLI by tools/install-watch.sh (via NODE_OPTIONS).
//
// `zeus preview` draws the install QR code in the terminal but never prints the link it
// encodes. Terminal QR codes are easy to mangle: the compact style is drawn light-on-dark,
// so it comes out inverted on a light terminal theme. This hook intercepts the same call
// and also writes a large, crisp QR code to an HTML page, then opens it in the browser.
const Module = require('module')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const OUT = process.env.LEZEPPLEAN_QR_OUT
const originalLoad = Module._load

Module._load = function (request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments)
  if (request === 'qrcode-terminal' && OUT && exported && !exported.__lezeppleanHooked) {
    const generate = exported.generate
    const libDir = path.dirname(Module._resolveFilename(request, parent))
    exported.generate = function (text) {
      try {
        writePage(text, path.join(libDir, '..', 'vendor', 'QRCode'))
      } catch (e) {
        console.error('[install] could not save the QR code image: ' + e.message)
      }
      return generate.apply(this, arguments)
    }
    exported.__lezeppleanHooked = true
  }
  return exported
}

function writePage(text, vendorDir) {
  const QRCode = require(vendorDir)
  const QRErrorCorrectLevel = require(path.join(vendorDir, 'QRErrorCorrectLevel'))
  const qr = new QRCode(-1, QRErrorCorrectLevel.M)
  qr.addData(text)
  qr.make()

  const n = qr.getModuleCount()
  const quiet = 4
  const size = n + quiet * 2
  let cells = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) cells += `M${c + quiet} ${r + quiet}h1v1h-1z`
    }
  }

  const page = `<!doctype html>
<meta charset="utf-8">
<title>Install LeZeppLean</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f4f2; color: #1a1a1a;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { text-align: center; padding: 32px 16px; max-width: 520px; }
  svg { width: min(80vw, 440px); height: auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin: 0 0 4px; }
  ol { text-align: left; display: inline-block; margin: 20px 0 0; padding-left: 20px; }
  .note { color: #666; font-size: 14px; margin-top: 12px; }
</style>
<main>
  <h1>Install LeZeppLean on your T-Rex 3</h1>
  <svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Install QR code">
    <rect width="${size}" height="${size}" fill="#fff"/><path d="${cells}" fill="#000"/>
  </svg>
  <ol>
    <li>On your phone, open the Zepp app → Profile → Developer Mode.</li>
    <li>Tap <b>Scan</b> and point the camera at this code.</li>
    <li>Keep the watch near the phone until the install finishes.</li>
  </ol>
  <p class="note">This code works for 7 days. Built ${new Date().toLocaleString()}.</p>
</main>
`
  fs.writeFileSync(OUT, page)
  execFile('open', [OUT], () => {})
  console.log('[install] QR code also opened in your browser: ' + OUT)
}
