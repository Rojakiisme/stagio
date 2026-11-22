// The site's buttons: language, Windows / Mac, and on the guide the contents, search and the
// section you are in. prefs.js (in <head>) has already set the classes on <html>.
(function () {
  var P = window.stagioPrefs;
  var root = document.documentElement;
  var zh = P.lang === 'zh';
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  // ---- language ----
  function showLang(l) {
    P.lang = l; zh = l === 'zh';
    root.classList.remove('lang-zh', 'lang-en');
    root.classList.add('lang-' + l);
    root.lang = zh ? 'zh-Hans' : 'en';
    $$('[data-lang-toggle]').forEach(function (b) {
      b.innerHTML = zh ? '<span class="long">English</span><span class="short">EN</span>' : '中文'; // EN on a narrow phone
      b.setAttribute('aria-label', zh ? 'Switch to English' : '切换到中文');
    });
    $$('[data-guide]').forEach(function (a) { a.setAttribute('href', a.getAttribute('data-guide') + (zh ? 'zh.html' : '') + (a.getAttribute('data-hash') || '')); });
  }
  showLang(P.lang);
  $$('[data-lang-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = P.lang === 'zh' ? 'en' : 'zh';
      P.setLang(next);
      if (P.only && P.other) location.href = P.other + location.hash; else showLang(next);
    });
  });

  // ---- Windows / Mac ----
  function showOS() {
    $$('[data-set-os]').forEach(function (b) {
      if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', String(b.getAttribute('data-set-os') === P.os));
    });
    if (typeof search === 'function' && q && q.value) search(); // what matches depends on what is shown
  }
  $$('[data-set-os]').forEach(function (b) {
    b.addEventListener('click', function () { P.setOS(b.getAttribute('data-set-os')); showOS(); });
  });

  // ---- download page: the Mac button is the main one on a Mac ----
  if (P.detectedMac) root.classList.add('on-mac');

  // ---- guide: contents, search, where you are ----
  var side = document.getElementById('side');
  var q = document.getElementById('q');
  var info = document.getElementById('qInfo');
  var sections = $$('.g-body > section[id]');
  var links = $$('#toc a');
  var search = null;

  if (side) {
    var toggle = side.querySelector('.side-toggle');
    var close = function () { side.classList.remove('open'); if (toggle) toggle.setAttribute('aria-expanded', 'false'); };
    if (toggle) toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = side.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.forEach(function (a) { a.addEventListener('click', close); });
    document.addEventListener('click', function (e) { if (!side.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // The section in view: the last one whose top has passed the header.
  if (sections.length) {
    var current = null;
    var mark = function () {
      var top = (side && getComputedStyle(side).position === 'sticky' && innerWidth <= 960 ? side.getBoundingClientRect().bottom : 70) + 24;
      var now = null;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].offsetParent === null) continue; // hidden by the search
        if (sections[i].getBoundingClientRect().top <= top) now = sections[i].id; else break;
      }
      if (!now) { var first = sections.filter(function (s) { return s.offsetParent !== null; })[0]; now = first && first.id; }
      if (now === current) return;
      current = now;
      links.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + now)); });
    };
    var queued = false;
    addEventListener('scroll', function () { if (!queued) { queued = true; requestAnimationFrame(function () { queued = false; mark(); }); } }, { passive: true });
    addEventListener('resize', mark);
    mark();
  }

  // Search: shows only the sections that have every word typed, with the words marked.
  if (q && sections.length) {
    var marks = [];
    var unmark = function () {
      marks.forEach(function (m) { var p = m.parentNode; if (!p) return; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); });
      marks = [];
    };
    var markIn = function (el, words) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        // skip the text of the other system (hidden)
        acceptNode: function (n) { return n.parentNode.offsetParent === null ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      var re = new RegExp('(' + words.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
      nodes.forEach(function (n) {
        if (!re.test(n.nodeValue)) return;
        re.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var last = 0;
        n.nodeValue.replace(re, function (m, g, at) {
          if (at > last) frag.appendChild(document.createTextNode(n.nodeValue.slice(last, at)));
          var mk = document.createElement('mark'); mk.textContent = m; frag.appendChild(mk); marks.push(mk);
          last = at + m.length;
        });
        if (last < n.nodeValue.length) frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
        n.parentNode.replaceChild(frag, n);
      });
    };
    var none = document.getElementById('noResults');
    search = function () {
      unmark();
      var words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      root.classList.toggle('searching', words.length > 0);
      var found = 0;
      sections.forEach(function (s, i) {
        s.classList.remove('nomatch');
        var hit = !words.length || words.every(function (w) { return s.innerText.toLowerCase().indexOf(w) !== -1; });
        s.classList.toggle('nomatch', !hit);
        if (links[i]) links[i].classList.toggle('nomatch', !hit);
        if (hit && words.length) { found++; markIn(s, words); }
      });
      if (none) none.hidden = !words.length || found > 0;
      if (info) info.textContent = !words.length ? '' : found
        ? (zh ? '找到 ' + found + ' 节 · Esc 清除' : found + (found === 1 ? ' section' : ' sections') + ' · Esc to clear')
        : (zh ? '没有找到' : 'Nothing found');
      // the results start below the video: bring them up if the page is still at the top
      var lay = document.querySelector('.g-layout');
      var head = document.querySelector('.site-head');
      if (words.length && lay && head) {
        var gap = lay.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
        if (gap > 1) scrollBy({ top: gap, behavior: 'instant' }); // 'auto' would follow the page's smooth scrolling
      }
    };
    var timer = null;
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 150); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { q.value = ''; search(); q.blur(); }
      if (e.key === 'Enter') { var m = marks[0]; if (m) m.scrollIntoView({ block: 'center' }); q.blur(); if (side) side.classList.remove('open'); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== q && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
    });
    var clear = document.getElementById('qClear');
    if (clear) clear.addEventListener('click', function () { q.value = ''; search(); q.focus(); });
    var fromUrl = (/[?&]q=([^&#]*)/.exec(location.search) || [])[1];
    if (fromUrl) { q.value = decodeURIComponent(fromUrl.replace(/\+/g, ' ')); search(); }
  }

  showOS();
})();
