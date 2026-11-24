(function () {
  const $ = id => document.getElementById(id);
  const loginBox = $('login'), chatBox = $('chat');
  const log = $('log'), input = $('input'), status = $('status');

  let ws = null;
  let me = null;
  let currentRoom = null;
  let pendingLogin = null;
  const sent = [];       // input history (up arrow)
  let sentIdx = 0;

  // ---------- helpers ----------
  function line(cls, build) {
    const d = document.createElement('div');
    d.className = 'line ' + (cls || '');
    build(d);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(d);
    while (log.children.length > 500) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
    return d;
  }

  function nickSpan(nick, color) {
    const s = document.createElement('span');
    s.className = 'nick';
    s.style.color = color || '#000';
    s.textContent = nick;
    return s;
  }

  function text(parent, t) { parent.appendChild(document.createTextNode(t)); }

  let audio = null;
  function beep() {
    if (!$('sound').checked) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.04;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.12);
    } catch (e) { /* no audio, fine */ }
  }

  function mentions(t) {
    return me && t.toLowerCase().includes(me.toLowerCase());
  }

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');
    status.textContent = 'Connecting...';

    ws.onopen = () => {
      status.textContent = 'Connected';
      if (pendingLogin) ws.send(JSON.stringify(pendingLogin));
    };
    ws.onclose = () => {
      status.textContent = 'Disconnected from server';
      if (me) line('err', d => text(d, '*** Connection lost. Reload the page to reconnect.'));
    };
    ws.onerror = () => { $('loginError').textContent = 'Could not reach the chat server.'; };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMessage(m); };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'login_error':
        $('loginError').textContent = m.text;
        pendingLogin = null;
        break;
      case 'login_ok':
        me = m.nick;
        loginBox.hidden = true;
        chatBox.hidden = false;
        status.textContent = 'Connected as ' + me;
        input.focus();
        break;
      case 'joined':
        currentRoom = m.room;
        $('roomName').textContent = m.room;
        log.textContent = '';
        line('sys', d => text(d, '*** Now talking in ' + m.room));
        highlightRoom();
        break;
      case 'msg': {
        const hit = m.nick !== me && mentions(m.text);
        line('', d => {
          d.appendChild(nickSpan('<' + m.nick + '>', m.color));
          text(d, ' ');
          const s = document.createElement('span');
          if (hit) s.className = 'mention';
          s.textContent = m.text;
          d.appendChild(s);
        });
        if (hit) beep();
        break;
      }
      case 'action':
        line('action', d => { text(d, '* '); d.appendChild(nickSpan(m.nick, m.color)); text(d, ' ' + m.text); });
        break;
      case 'pm': {
        const outgoing = m.from === me;
        line('pm', d => {
          text(d, outgoing ? '[to ' + m.to + '] ' : '[from ' + m.from + '] ');
          text(d, m.text);
        });
        if (!outgoing) beep();
        break;
      }
      case 'sys': line('sys', d => text(d, m.text)); break;
      case 'err': line('err', d => text(d, m.text)); break;
      case 'clear': log.textContent = ''; break;
      case 'kicked':
        line('err', d => text(d, '*** You were removed by a moderator.'));
        break;
      case 'rooms': renderRooms(m.rooms); break;
      case 'users': renderUsers(m.users); break;
    }
  }

  // ---------- side panels ----------
  let roomData = [];
  function renderRooms(rooms) {
    roomData = rooms;
    const ul = $('rooms');
    ul.textContent = '';
    rooms.forEach(r => {
      const li = document.createElement('li');
      li.textContent = r.name + ' (' + r.count + ')';
      li.dataset.room = r.name;
      li.title = 'Click to join';
      li.onclick = () => say('/join ' + r.name);
      ul.appendChild(li);
    });
    highlightRoom();
  }
  function highlightRoom() {
    document.querySelectorAll('#rooms li').forEach(li =>
      li.classList.toggle('current', li.dataset.room === currentRoom));
  }
  function renderUsers(users) {
    const ul = $('users');
    ul.textContent = '';
    $('userCount').textContent = '(' + users.length + ')';
    users.forEach(u => {
      const li = document.createElement('li');
      li.textContent = (u.op ? '@' : '') + u.nick;
      li.style.color = u.color;
      li.title = 'Double-click to private message';
      li.ondblclick = () => { input.value = '/msg ' + u.nick + ' '; input.focus(); };
      ul.appendChild(li);
    });
  }

  // ---------- sending ----------
  function say(t) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'say', text: t }));
  }

  $('form').addEventListener('submit', e => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    say(t);
    sent.push(t); if (sent.length > 50) sent.shift();
    sentIdx = sent.length;
    input.value = '';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && sentIdx > 0) { sentIdx--; input.value = sent[sentIdx]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') {
      sentIdx = Math.min(sentIdx + 1, sent.length);
      input.value = sent[sentIdx] || '';
      e.preventDefault();
    }
  });

  // ---------- login ----------
  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    $('loginError').textContent = '';
    const nick = $('nick').value.trim();
    const adult = $('adult').checked;
    if (!adult) { $('loginError').textContent = 'Please confirm you are 18 or over.'; return; }
    if (!nick) { $('loginError').textContent = 'Please enter a nickname.'; return; }
    pendingLogin = { t: 'login', nick, adult };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(pendingLogin));
    else connect();
  });
})();
