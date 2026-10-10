// Drives the real watch view (watch-app/lib/view.js) through its states and records what
// would be on screen. Run: node --import ./tests/render/register.mjs tests/render/screens.mjs out.json
import { writeFileSync } from 'node:fs'
import { snapshot, setCalls } from './zos-ui.mjs'
import { createView } from '../../watch-app/lib/view.js'

const song = { title: 'Wonderwall', artist: 'Oasis', kind: 'synced' }
const lines = [
  [40270, '', null, null],
  [44407, 'And backbeat, the word is on the street that the fire in your heart is out',
    [44407, 44487, 45347, 45507, 45747, 45967, 46067, 46167, 46547, 46747, 46907, 47347, 47447, 47627, 47987, 48568], 48708],
  [50088, "I'm sure you've heard it all before, but you never really had a doubt", null, null],
  [55248, "I don't believe that anybody feels the way I do about you now",
    [55248, 55400, 55900, 56300, 56900, 57400, 57800, 58100, 58500, 58800, 59200, 59900, 60300], 61248],
  [62340, '', null, null],
  [65948, 'And all the roads we have to walk are winding', [65948, 66200, 66500, 66800, 67100, 67400, 67700, 68000, 68400], 69849],
]
const shots = {}
const view = createView({ onTap() {} })
const shot = (name) => (shots[name] = snapshot())

view.showMessage('Listening…', 'Hold the watch near the music')
shot('01-listening')

view.showSong(song)
view.setStatus('▲▼ lyrics earlier / later')
view.setSongProgress(0.16)
shot('02-song-found')

view.setStatus('')
view.showLine(lines, 5, 'v1')
view.setWord(-1)
view.setSongProgress(0.25)
shot('03-line-appears')

view.setWord(3)
shot('04-words-being-sung')

view.showLine(lines, 1, 'v1')
view.setWord(9)
shot('05-long-line')

view.showLine(lines, 2, 'v1')
view.setLineProgress(0.45)
shot('06-line-without-word-timings')

view.showLine(lines, 3, 'v1')
view.setWord(5)
view.setPaused(true)
shot('07-paused')

view.setPaused(false)
view.showLine(lines, 4, 'v1')
shot('08-instrumental-gap')

view.showSong({ title: 'Some Instrumental', artist: 'Band', kind: 'none' })
shot('09-no-synced-lyrics')

view.showLine(lines, 3, 'v1')
view.setWord(5)
view.setDebug(['API 5.0 · FW 6.4.16.3 · live', 'gain thr 21 · floor 16 · music 27 · track -14', 'playing · matches 4 · rate 1.0000 · adj 0',
  'pauses 1 · resumes 1 · refused 0', 'skips 0 · round trip 2380 ms', 'server 31 ms · track · words ready 30/45'].join('\n'))
shot('10-diagnostics')

writeFileSync(process.argv[2], JSON.stringify(shots))
console.log(Object.keys(shots).length, 'screens;', setCalls, 'property sets in total')
