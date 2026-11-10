// The login-link page (DIVE-6219). Redeems the one-time link from THIS origin,
// then shows the box's browser through noVNC. Nothing is redeemed until this
// script runs, so a link preview that only fetches the URL spends nothing.
//
// A PHONE SEES A PHONE PAGE (DIVE-6646). The redeem carries this page's size. A
// phone-wide page gets the box's browser window narrowed to it (fit=WxH), so the
// site uses its own phone layout, and this page draws only that corner of the
// box's screen, scaled to the phone's width: about 1:1, not 1280 px at 0.3. A
// desktop page gets no fit and draws the whole screen, as before.
//
// ONE LAYOUT WITH THE HOSTED VIEWER (DIVE-7223): a 44-px bar on top with the
// site, a line of help, Type and Paste (viewer-ui.js), the box's screen below it.
// The size sent with the redeem is the area under the bar, the one the screen is
// drawn in.
import { TEXT, pickText, wireBar, wireDone, fitScale } from './viewer-ui.js';

const BAR = 44;
const t = pickText(navigator.languages);
document.documentElement.lang = t === TEXT.ru ? 'ru' : 'en';
document.title = document.getElementById('site').textContent + ' — ' + t.title;
const msg = document.getElementById('msg');
const say = (s, again) => {
  msg.textContent = s;
  if (again) {
    // DIVE-7675: not signed in yet, so a fresh link to the same window.
    const a = document.createElement('a');
    a.href = again; a.textContent = t.openAgain;
    msg.append(document.createElement('br'), a);
  }
  msg.style.display = 'grid';
};
say(t.opening);
const base = location.pathname.replace(/\/+$/, '');
let r;
try {
  r = await fetch(base + '/redeem', {
    method: 'POST', cache: 'no-store',
    headers: { 'x-5dive-viewer': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ w: Math.round(innerWidth), h: Math.round(innerHeight - BAR) }),
  });
} catch (e) {
  r = null;
}
let j = {};
try { j = r ? await r.json() : {}; } catch (e) { j = {}; }
if (!r || !r.ok || !j.ws || !j.password) {
  say(j.error || t.spent);
} else {
  const { default: RFB } = await import('/browser/viewer/assets/novnc/core/rfb.js');
  msg.style.display = 'none';
  const screen = document.getElementById('screen');
  const fit = /^(\d+)x(\d+)$/.exec(j.fit || ''), full = /^(\d+)x(\d+)$/.exec(j.screen || '');
  if (fit && full) {
    // The whole screen, scaled so the fitted window fills the page under the
    // bar, laid from the top-left corner: noVNC's own fit-to-box scaling then
    // draws exactly that, and a tap lands where it is drawn (no CSS transform
    // between the canvas and noVNC's pointer maths). The rest is off the page.
    // The height is the smaller scale too, so a page that shrank since the
    // redeem never loses the bottom of the login form. fitScale reads the
    // layout viewport, not innerWidth (DIVE-7882: Type blew the screen up 4x).
    const place = () => {
      const s = fitScale(document, +fit[1], +fit[2], BAR);
      screen.style.cssText = 'right:auto;bottom:auto;' +
        'width:' + (+full[1] * s) + 'px;height:' + (+full[2] * s) + 'px';
    };
    place();
    document.body.style.overflow = 'hidden';
    addEventListener('resize', place);
  }
  const rfb = new RFB(screen, 'wss://' + location.host + j.ws, { credentials: { password: j.password } });
  j.password = '';
  rfb.scaleViewport = true;
  const bar = wireBar(document, rfb, t, navigator.clipboard);
  // DIVE-7675: the chat's Done, here. Root closes this view when it runs, so the
  // disconnect that follows must not cover the answer with "closed".
  const done = wireDone(document, t, j.done ? async () => {
    const d = await fetch(j.done, { method: 'POST', cache: 'no-store', headers: { 'x-5dive-viewer': '1' } });
    return d.json();
  } : null, say);
  rfb.addEventListener('connect', () => { bar.connect(); done.connect(); });
  rfb.addEventListener('disconnect', () => { bar.disconnect(); if (!done.pressed()) say(t.closed); });
  rfb.addEventListener('credentialsrequired', () => say(t.password));
}
