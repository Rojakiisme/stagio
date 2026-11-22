// Runs in <head>, before the page is drawn: the language (中文 / English) and the system the page
// is about (Windows / Mac). Both are kept in this browser. The first visit follows the browser's
// language and the computer it runs on. site.js wires up the buttons.
// The download page switches language in place; the guide is one page per language
// (<html data-only="en" data-other="zh.html">) and switching goes to the other page.
(function () {
  var root = document.documentElement;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: not kept */ } }

  // ---- language ----
  var pref = get('stagio.lang');
  var lang = pref || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  var only = root.getAttribute('data-only');
  var other = root.getAttribute('data-other');
  // A one-language page sends the reader to the other one when they chose that language, or on a
  // first visit to the default (English) page from a Chinese browser. A shared link to the Chinese
  // page stays Chinese for someone who hasn't chosen.
  if (only && other && only !== lang && (pref || only === 'en')) { location.replace(other + location.search + location.hash); return; }
  lang = only || lang;
  root.classList.remove('lang-zh', 'lang-en');
  root.classList.add('lang-' + lang);
  root.lang = lang === 'zh' ? 'zh-Hans' : 'en';

  // ---- system ----
  // An iPad says "Mac" too; it has a touch screen, a Mac doesn't. Phones default to Windows.
  var ua = navigator.userAgent || '';
  var mac = /Mac/i.test(navigator.platform || ua) && !(navigator.maxTouchPoints > 1) && !/iPhone|iPad|iPod/i.test(ua);
  var fromUrl = (/[?&]os=(win|mac)\b/.exec(location.search) || [])[1];
  var os = fromUrl || get('stagio.os') || (mac ? 'mac' : 'win');
  root.classList.add('os-' + os);

  window.stagioPrefs = {
    lang: lang,
    only: only,
    other: other,
    os: os,
    detectedMac: mac,
    setLang: function (l) { set('stagio.lang', l); },
    setOS: function (v) {
      if (v !== 'win' && v !== 'mac') return;
      this.os = v;
      set('stagio.os', v);
      root.classList.remove('os-win', 'os-mac');
      root.classList.add('os-' + v);
    },
  };
})();
