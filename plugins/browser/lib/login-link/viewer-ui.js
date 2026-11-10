// The login-link page's top bar (DIVE-7223): the site's name, one line of help,
// and Type / Paste, the same bar and the same behaviour as the 5dive.ai hosted
// viewer (shelld's viewerPage in 5dive-api). lodar, 2026-10-29: the self-hosted
// page should look like the hosted one, and its Keyboard button did nothing.
//
// WHY A VISIBLE FIELD AND A SEND BUTTON, not a hidden input that forwards each
// key (the DIVE-6219 Keyboard button). A phone keyboard types through an input
// method: Gboard sends keydown "Unidentified" (229) for letters and Backspace and
// rewrites a composing word on every key. Forwarding each `input` and clearing
// the field broke that word, so "hello" arrived as "hhehelhellhello", and a
// Backspace never arrived at all; an off-screen 1x1 input does not raise the
// keyboard on every phone either. Here the owner types into a real field in the
// bar, where the phone's keyboard edits it as it likes, and Send delivers the
// finished text once. Node-importable: tests/browser_viewer_keyboard_unit.sh.

export const TEXT = {
  en: {
    note: 'Log in here. This window is one-time — closing it ends the view.',
    placeholder: 'Paste or type here',
    send: 'Send',
    type: 'Type',
    typeTitle: 'Type into the page with your own keyboard',
    paste: 'Paste',
    pasteTitle: 'Paste your clipboard into the page',
    title: 'log in',
    opening: 'Opening the login screen…',
    spent: 'This login link cannot be used any more. Ask your agent for a new one.',
    closed: 'The login screen is closed. If you are finished, tap Done.',
    password: 'The login screen asked for a password it was not given. Ask your agent for a new link.',
    done: 'Done',
    doneTitle: 'Finished? Your agent checks the sign-in and carries on',
    checking: 'Checking the sign-in…',
    saved: 'Saved. Your agent is carrying on.',
    carryOn: 'Done. Your agent is carrying on.',
    notYet: 'Not signed in yet.',
    notYetAsk: 'Not signed in yet. Ask your agent for a new link.',
    openAgain: 'Open it again',
    doneGone: 'This sign-in is already finished. Check your chat.',
    doneFailed: 'Could not finish from here. Tap Done in your chat.',
  },
  ru: {
    note: 'Войдите здесь. Окно одноразовое — если его закрыть, просмотр закончится.',
    placeholder: 'Вставьте или введите текст',
    send: 'Отправить',
    type: 'Ввод',
    typeTitle: 'Печатать на странице со своей клавиатуры',
    paste: 'Вставить',
    pasteTitle: 'Вставить текст из буфера обмена на страницу',
    title: 'вход',
    opening: 'Открываем окно входа…',
    spent: 'Эта ссылка для входа больше не работает. Попросите агента прислать новую.',
    closed: 'Окно входа закрыто. Если вы закончили, нажмите «Готово».',
    password: 'Окну входа не хватило пароля. Попросите агента прислать новую ссылку.',
    done: 'Готово',
    doneTitle: 'Закончили? Агент проверит вход и продолжит',
    checking: 'Проверяем вход…',
    saved: 'Сохранено. Агент продолжает.',
    carryOn: 'Готово. Агент продолжает.',
    notYet: 'Вход ещё не выполнен.',
    notYetAsk: 'Вход ещё не выполнен. Попросите агента прислать новую ссылку.',
    openAgain: 'Открыть снова',
    doneGone: 'Этот вход уже завершён. Загляните в чат.',
    doneFailed: 'Отсюда завершить не удалось. Нажмите Done в чате.',
  },
};

// The first of the browser's own languages that TEXT has; English otherwise.
export function pickText(langs) {
  for (const l of langs || []) {
    const t = TEXT[String(l).toLowerCase().split('-')[0]];
    if (t) return t;
  }
  return TEXT.en;
}

// How long a pasted string stays on the box clipboard (the hosted viewer's
// DIVE-5020 value): Chrome reads the selection after the key, so clearing it at
// once would race the paste.
export const PASTE_CLEAR_MS = 2000;

// Puts text into the focused field of the box's browser. x11vnc speaks only
// classic cut text, which noVNC sends as Latin-1, so Latin-1 text goes through
// the box clipboard and Ctrl+V (then the clipboard is emptied, so a pasted
// password does not stay where the agent's browser could read it); anything
// else is typed as Unicode keysyms. Same rules as the hosted viewer.
export function sendText(rfb, text, timer = { id: 0 }) {
  if (!text) return;
  if ([...text].every((ch) => ch.codePointAt(0) < 0x100)) {
    rfb.clipboardPasteFrom(text);
    rfb.sendKey(0xffe3, 'ControlLeft', true);
    rfb.sendKey(0x76, 'KeyV');
    rfb.sendKey(0xffe3, 'ControlLeft', false);
    clearTimeout(timer.id);
    timer.id = setTimeout(() => rfb.clipboardPasteFrom(''), PASTE_CLEAR_MS);
  } else {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 13 || (cp < 0x20 && cp !== 9 && cp !== 10)) continue;
      rfb.sendKey(cp === 10 ? 0xff0d : cp === 9 ? 0xff09 : cp < 0x100 ? cp : 0x01000000 + cp, null);
    }
  }
  rfb.focus();
}

// Takes the page back to its own scale when a phone has zoomed it in (DIVE-7379).
// lodar, 2026-10-31, Brave on Android: after Type the page stayed zoomed on a
// corner of the box's screen, and a pinch there goes to the box (noVNC takes the
// touches), so nothing on the page could zoom it back out. A viewport that may
// not zoom past 1 makes the browser drop to 1; the old one comes back a moment
// later, so the owner can still pinch-zoom the bar.
export const UNZOOM_MS = 300;
export function unzoom(doc, win) {
  const meta = doc.querySelector && doc.querySelector('meta[name="viewport"]');
  if (!win || !meta || (win.visualViewport && win.visualViewport.scale <= 1)) return false;
  const was = meta.getAttribute('content');
  // Send blurs the field, so a second call can come before the first one's
  // restore: that one already has the page's own viewport to give back.
  if (/maximum-scale/.test(was)) return false;
  // Chrome takes a changed viewport only at a layout that has something to lay
  // out, so each step also moves the page's height by a hair (on 5dive-ci,
  // without it the cap did not apply when the keyboard closed with no Send, and
  // the restore never did: the page could not be pinch-zoomed again).
  const html = doc.documentElement;
  meta.setAttribute('content', was + ', maximum-scale=1');
  if (html) html.style.minHeight = '100.01%';
  win.setTimeout(() => {
    meta.setAttribute('content', was);
    if (html) html.style.minHeight = '';
  }, UNZOOM_MS);
  return true;
}

// The scale the box's screen is drawn at on a phone (DIVE-7882): the fitted
// window's width, or less if the page under the bar is shorter. Read off the
// LAYOUT viewport (the root's client size), never innerWidth/innerHeight: in
// Chrome those follow the page's own zoom, and the screen (wider than the
// phone, the rest off the page) lets Chrome zoom out to it, so on a 412-px
// phone innerWidth read 1648 and the first resize after load, the keyboard
// opening on Type, drew the screen 4 times too big (lodar, 2026-11-07, Brave
// on Android). The client size does not move with zoom or with a keyboard laid
// over the page, so Type keeps the scale, or shrinks it where the keyboard
// shrinks the page itself.
export function fitScale(doc, fw, fh, bar) {
  const de = doc.documentElement;
  return Math.min(de.clientWidth / fw, (de.clientHeight - bar) / fh);
}

// Labels the bar in the viewer's language and wires Type, Paste and Send to the
// noVNC connection. The buttons stay disabled until connect() is called.
export function wireBar(doc, rfb, t, clipboard, win = doc.defaultView) {
  const $ = (id) => doc.getElementById(id);
  const note = $('note'), typeBtn = $('type'), pasteBtn = $('paste'), box = $('pastebox'), field = $('pastein');
  note.textContent = t.note;
  field.placeholder = t.placeholder;
  box.querySelector('button').textContent = t.send;
  typeBtn.textContent = t.type; typeBtn.title = t.typeTitle;
  pasteBtn.textContent = t.paste; pasteBtn.title = t.pasteTitle;
  let live = false;
  const timer = { id: 0 };
  // Shown and focused in the tap's own handler, on screen: that is what lets a
  // phone raise its keyboard.
  const open = () => { note.hidden = true; box.hidden = false; field.focus(); };
  typeBtn.addEventListener('click', open);
  pasteBtn.addEventListener('click', async () => {
    let text = null;
    try { text = await clipboard.readText(); } catch (e) { text = null; }
    if (text && live) sendText(rfb, text, timer); else open();
  });
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = field.value;
    field.value = '';
    if (live) sendText(rfb, text, timer);
    unzoom(doc, win);
  });
  // The phone's keyboard closing (Send, its own back key, a tap on the screen).
  field.addEventListener('blur', () => unzoom(doc, win));
  return {
    connect() { live = true; typeBtn.disabled = false; pasteBtn.disabled = false; },
    disconnect() {
      live = false; typeBtn.disabled = true; pasteBtn.disabled = true;
      box.hidden = true; field.value = '';
      clearTimeout(timer.id);
    },
  };
}

// The bar's Done (DIVE-7675): the chat's Done, pressed in the view itself. Root
// answers with one word; this turns it into the one plain line the owner reads,
// and "not signed in yet" carries the fresh link back into the same window.
export function doneResult(t, j) {
  const r = j && j.result;
  if (r === 'saved') return { line: t.saved, final: true };
  if (r === 'carryon') return { line: t.carryOn, final: true };
  if (r === 'notyet') return j.again ? { line: t.notYet, again: j.again, final: true } : { line: t.notYetAsk, final: true };
  if (r === 'gone') return { line: t.doneGone, final: true };
  return { line: t.doneFailed, final: false };
}

// Labels Done and wires it to press(), which resolves to root's answer. show(line,
// again) puts the line (and the way back in) where the screen was. A press that
// reached root is spent; only one that never did may be pressed again.
export function wireDone(doc, t, press, show) {
  const btn = doc.getElementById('done');
  btn.textContent = t.done; btn.title = t.doneTitle;
  if (!press) { btn.hidden = true; return { connect() {}, pressed: () => false }; }
  let pressed = false;
  btn.addEventListener('click', async () => {
    if (pressed) return;
    pressed = true; btn.disabled = true;
    show(t.checking);
    let j = null;
    try { j = await press(); } catch (e) { j = null; }
    const r = doneResult(t, j);
    show(r.line, r.again);
    if (!r.final) { pressed = false; btn.disabled = false; }
  });
  return { connect() { if (!pressed) btn.disabled = false; }, pressed: () => pressed };
}
