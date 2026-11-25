package ai.fivedive.phone;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Puts text on the phone's clipboard so `input keyevent PASTE` can type it.
 *
 * WHY. adb's `input text` maps each character to a key on a US keyboard, so it
 * types plain English letters and nothing else: no emoji, no accents, no
 * Cyrillic. A paste carries any text.
 *
 * HOW IT RUNS. `5dive phone` copies this one file to /data/local/tmp, runs it
 * with Android's own `app_process` as the adb shell user, and deletes it again.
 * Nothing is installed: no app, no icon, no permission prompt.
 *
 * Android's public ClipboardManager needs an app Context, so this calls the
 * clipboard service directly, the way the system's own shell tools do. Its
 * method signatures grew a parameter or two between Android 9 and 15; every
 * public method of that name is tried, each argument filled by its type.
 *
 *   app_process / ai.fivedive.phone.Type set <base64 of UTF-8 text>
 *   app_process / ai.fivedive.phone.Type clear
 */
public final class Type {
  private static final String SHELL = "com.android.shell";
  // SystemUI hides its "Copied" panel for a clip that carries this extra, but
  // only when the clip comes from the shell. The panel would cover the screen
  // the next step taps.
  private static final String NO_OVERLAY = "com.android.systemui.SUPPRESS_CLIPBOARD_OVERLAY";
  // Keyboards with a clipboard history (Gboard) do not keep a sensitive clip.
  private static final String SENSITIVE = "android.content.extra.IS_SENSITIVE";

  public static void main(String[] args) {
    try {
      if (args.length == 2 && args[0].equals("set")) {
        String text = new String(Base64.getDecoder().decode(args[1]), StandardCharsets.UTF_8);
        call("setPrimaryClip", clip(text));
      } else if (args.length == 1 && args[0].equals("clear")) {
        if (!tryCall("clearPrimaryClip", null)) call("setPrimaryClip", clip(""));
      } else {
        System.out.println("usage: set <base64> | clear");
        System.exit(2);
      }
      System.out.println("ok");
    } catch (Throwable t) {
      Throwable c = t.getCause() != null ? t.getCause() : t;
      System.out.println("error: " + c);
      System.exit(1);
    }
  }

  private static Object clip(String text) throws Exception {
    Class<?> clipData = Class.forName("android.content.ClipData");
    Object clip = clipData.getMethod("newPlainText", CharSequence.class, CharSequence.class)
        .invoke(null, "5dive", text);
    Class<?> bundle = Class.forName("android.os.PersistableBundle");
    Object extras = bundle.getConstructor().newInstance();
    Method put = bundle.getMethod("putBoolean", String.class, boolean.class);
    put.invoke(extras, NO_OVERLAY, true);
    put.invoke(extras, SENSITIVE, true);
    Object desc = clipData.getMethod("getDescription").invoke(clip);
    desc.getClass().getMethod("setExtras", bundle).invoke(desc, extras);
    return clip;
  }

  private static Object service() throws Exception {
    Object binder = Class.forName("android.os.ServiceManager")
        .getMethod("getService", String.class).invoke(null, "clipboard");
    if (binder == null) throw new IllegalStateException("no clipboard service");
    return Class.forName("android.content.IClipboard$Stub")
        .getMethod("asInterface", Class.forName("android.os.IBinder")).invoke(null, binder);
  }

  private static void call(String name, Object clip) throws Exception {
    if (!tryCall(name, clip)) throw new NoSuchMethodException("IClipboard." + name);
  }

  private static boolean tryCall(String name, Object clip) throws Exception {
    Object svc = service();
    Exception last = null;
    for (Method m : svc.getClass().getMethods()) {
      if (!m.getName().equals(name)) continue;
      Class<?>[] p = m.getParameterTypes();
      Object[] a = new Object[p.length];
      int strings = 0;
      boolean fits = true;
      for (int i = 0; i < p.length; i++) {
        if (clip != null && p[i].isInstance(clip)) a[i] = clip;
        else if (p[i] == String.class) a[i] = strings++ == 0 ? SHELL : null;  // package, then attribution tag
        else if (p[i] == int.class) a[i] = 0;  // user 0, default device
        else fits = false;
      }
      if (!fits || (clip != null && (p.length == 0 || !p[0].isInstance(clip)))) continue;
      try {
        m.invoke(svc, a);
        return true;
      } catch (Exception e) {
        last = e;
      }
    }
    if (last != null) throw last;
    return false;
  }
}
