// LeZeppLean settings, shown inside the Zepp phone app (Profile → your watch → LeZeppLean).
import { DEFAULT_SERVER_URL } from '../app-side/defaults'

// The languages the watch can draw (with their letters reordered: see server/lezepplean/visual.py),
// and the script each is written in: the script is what decides whether you can read it.
const READABLE = [
  ['Hindi, Marathi, Nepali', 'Devanagari'],
  ['Bengali, Assamese', 'Bengali'],
  ['Tamil', 'Tamil'],
  ['Malayalam', 'Malayalam'],
  ['Kannada', 'Kannada'],
  ['Urdu', 'Arabic'],
]

AppSettingsPage({
  build(props) {
    const storage = props.settingsStorage
    const result = storage.getItem('pingResult')
    const help = DEFAULT_SERVER_URL
      ? 'This install already points at ' + DEFAULT_SERVER_URL + '. Leave the fields empty to use it, or enter another server to override it.'
      : 'Where the watch sends its short mic clips. At home, use your Mac on the same Wi-Fi, e.g. http://192.168.1.20:8787. Away from home, use the HTTPS tunnel URL.'

    return View({ style: { padding: '12px 16px' } }, [
      Section({ title: 'Recognition server' }, [
        Text({ paragraph: true, style: { fontSize: '13px', color: '#666666' } }, help),
        TextInput({ label: 'Server URL', placeholder: 'http://192.168.1.20:8787', settingsKey: 'serverUrl' }),
        TextInput({ label: 'Access token (only if the server sets one)', placeholder: 'optional', settingsKey: 'token' }),
        Button({ label: 'Test connection', color: 'primary', onClick: () => storage.setItem('pingRequest', String(Date.now())) }),
        Text({ paragraph: true, style: { marginTop: '8px' } }, result || 'Not tested yet'),
      ]),
      Section({ title: 'Lyrics in other languages' }, [
        Text(
          { paragraph: true, style: { fontSize: '13px', color: '#666666' } },
          'Songs in a language you read show in its own script. Everything else shows in English letters, so you can sing along. ' +
            'Telugu, Punjabi, Gujarati and Odia are always in English letters: the watch has no letters for them.',
        ),
        ...READABLE.map(([label, script]) => Toggle({ label, settingsKey: 'read_' + script })),
      ]),
      Section({ title: 'On the watch' }, [
        Text(
          { paragraph: true, style: { fontSize: '13px', color: '#666666' } },
          'SELECT: listen now · UP / DOWN: move lyrics 0.1 s earlier / later · hold SELECT: diagnostics · tap the screen: listen.',
        ),
      ]),
    ])
  },
})
