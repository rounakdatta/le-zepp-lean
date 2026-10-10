// LeZeppLean settings, shown inside the Zepp phone app (Profile → your watch → LeZeppLean).
import { DEFAULT_SERVER_URL } from '../app-side/defaults'

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
      Section({ title: 'On the watch' }, [
        Text(
          { paragraph: true, style: { fontSize: '13px', color: '#666666' } },
          'SELECT: listen now · UP / DOWN: move lyrics 0.1 s earlier / later · hold SELECT: diagnostics · tap the screen: listen.',
        ),
      ]),
    ])
  },
})
