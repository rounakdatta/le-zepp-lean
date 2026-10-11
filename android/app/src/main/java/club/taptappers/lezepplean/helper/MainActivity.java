package club.taptappers.lezepplean.helper;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;

/**
 * Two steps, then nothing to do: allow reading what plays, and connect to the server.
 * After that the helper works in the background; this screen only says how it is doing.
 */
public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView access;
    private TextView accessHint;
    private Button allow;
    private EditText server;
    private EditText token;
    private TextView connection;
    private TextView status;
    private Reporter reporter;

    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            show();
            main.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        reporter = Reporter.get(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        col.setPadding(pad, pad, pad, pad);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        logo.setContentDescription("LeZeppLean");
        col.addView(logo, new LinearLayout.LayoutParams(dp(72), dp(72)));
        col.addView(text("LeZeppLean", 28, true), spaced(12));
        col.addView(text("Lyrics on your watch for what this phone plays: Spotify, YouTube Music, YouTube, any player. "
                + "Exactly in time, earphones or not.", 15, false), spaced(8));

        col.addView(text("1. Allow it to see what plays", 18, true), spaced(28));
        access = text("", 15, false);
        col.addView(access, spaced(6));
        accessHint = text("Android lets an app see what players play only with notification access. "
                + "If the switch is greyed out: Settings → Apps → LeZeppLean → ⋮ → Allow restricted settings, then try again.", 13, false);
        accessHint.setAlpha(0.7f);
        col.addView(accessHint, spaced(6));
        allow = new Button(this);
        allow.setText("Allow");
        allow.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        col.addView(allow, spaced(8));

        col.addView(text("2. Connect to your server", 18, true), spaced(28));
        server = new EditText(this);
        server.setHint("Server");
        server.setSingleLine(true);
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(reporter.server());
        col.addView(server, spaced(8));
        token = new EditText(this);
        token.setHint("Token (Bitwarden: lezepplean/token)");
        token.setSingleLine(true);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(reporter.token());
        col.addView(token, spaced(4));
        Button test = new Button(this);
        test.setText("Save and test");
        test.setOnClickListener(v -> saveAndTest());
        col.addView(test, spaced(8));
        connection = text("", 15, false);
        col.addView(connection, spaced(6));

        col.addView(text("Now", 18, true), spaced(28));
        status = text("", 15, false);
        col.addView(status, spaced(6));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.post(refresh);
        if (allowed()) NotificationListenerService.requestRebind(new ComponentName(this, NowPlayingService.class));
    }

    @Override
    protected void onPause() {
        super.onPause();
        main.removeCallbacks(refresh);
    }

    private void show() {
        boolean ok = allowed();
        access.setText(ok ? "Allowed." : "Not allowed yet.");
        accessHint.setVisibility(ok ? View.GONE : View.VISIBLE);
        allow.setVisibility(ok ? View.GONE : View.VISIBLE);
        long ago = reporter.lastAt == 0 ? -1 : (System.currentTimeMillis() - reporter.lastAt) / 1000;
        status.setText(reporter.lastResult + (ago < 0 ? "" : ago < 2 ? " (just now)" : " (" + ago + " s ago)"));
    }

    private boolean allowed() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(getPackageName());
    }

    private void saveAndTest() {
        reporter.prefs.edit()
                .putString("server", server.getText().toString().trim())
                .putString("token", token.getText().toString().trim())
                .apply();
        connection.setText("Testing…");
        String url = reporter.server();
        String key = reporter.token();
        Executors.newSingleThreadExecutor().execute(() -> {
            String result;
            HttpURLConnection h = null;
            try {
                h = (HttpURLConnection) new URL(url + "/health").openConnection();
                h.setConnectTimeout(8000);
                h.setReadTimeout(8000);
                h.setRequestProperty("Authorization", "Bearer " + key);
                int code = h.getResponseCode();
                result = code == 200 ? "Connected." : code == 401 ? "Reached the server, but it refused the token." : "The server answered " + code + ".";
            } catch (Exception e) {
                result = "Could not reach " + url + ".";
            } finally {
                if (h != null) h.disconnect();
            }
            String shown = result;
            main.post(() -> connection.setText(shown));
        });
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private LinearLayout.LayoutParams spaced(int topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(topDp);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
