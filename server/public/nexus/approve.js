// The device approval page (docs/design/nexus, boards 1 to 5). It reads the code from its own address, asks Nexus what
// is being asked, and lets the owner allow or deny it. Everything a device sent (its label, its code) goes on the page
// as text, never as markup: this file only sets text and shows or hides parts of the page, and builds nothing from what it
// was sent but plain boxes holding one character each.
//
//   GET  /nexus/api/device/pending?code=C    what is being asked, or a refusal
//   POST /nexus/api/device/approve { code }  Allow
//   POST /nexus/api/device/deny    { code }  Deny
//
// What the page shows:
//   board 1  the question, the device's code and Allow and Deny
//   board 2  allowed             board 3  denied
//   board 4  code ran out        board 5  code used
// A refusal that says the code is finished takes the question away, so nothing can be tapped twice: a 410 says why in
// its `reason` (expired is board 4, used is board 5) and a 404 (a code Nexus no longer has) is board 5. Any other refusal,
// and a code missing from the address, is shown in Nexus's own words.
(function () {
  'use strict';

  var DEVICE = '/nexus/api/device/';
  var MINUTE = 60 * 1000;
  var GROUP = 4;

  // The words, in one place. The boards name the app ("Obsidian"); Nexus does not know which app a device is, so the
  // page says "the device" and the label the device sent names it in the card.
  var WORDS = {
    checking: { title: 'new device', line: 'Checking the code…' },
    asking: { title: 'new device', line: 'A device wants to sign in.' },
    allowed: { title: 'allowed', line: 'The device is in.', quiet: 'You can close this page. The device picks it up by itself.' },
    denied: { title: 'denied', line: 'Nothing was shared.', quiet: 'Changed your mind? Start again on the device.' },
    expired: { title: 'code ran out', line: 'Ten minutes is up.', said: 'That code has run out.', quiet: 'Ask for a new one on the device.' },
    used: { title: 'code used', line: 'One answer per code.', said: 'That code was already used.', quiet: 'A code works once. Ask for a new one on the device.' },
    fault: { title: 'new device', line: 'That did not work.' },
  };
  var CANT_REACH = 'Nexus could not be reached. Check the connection and try again.';
  var NO_CODE = 'This link has no code in it. Open the link the device gave you.';

  function byId(id) { return document.getElementById(id); }
  var title = byId('title');
  var line = byId('line');
  var ask = byId('ask');
  var question = byId('question');
  var hint = byId('hint');
  var codeBoxes = byId('code');
  var allowButton = byId('allow');
  var denyButton = byId('deny');
  var alertBox = byId('alert');
  var result = byId('result');
  var said = byId('said');
  var quiet = byId('quiet');
  var MARKS = {
    allowed: byId('mark-allowed'),
    denied: byId('mark-denied'),
    expired: byId('mark-expired'),
    used: byId('mark-used'),
  };

  var code = new URLSearchParams(window.location.search).get('code');
  // What the device asked for, kept once Nexus has said so, to name it in the answer.
  var asked = null;

  function slab(words) {
    title.textContent = words.title;
    line.textContent = words.line;
  }

  function setBusy(busy) {
    allowButton.disabled = busy;
    denyButton.disabled = busy;
  }

  // Asks Nexus and hands back { ok, status, body }, or null when Nexus could not be reached.
  function call(method, route, body) {
    var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(DEVICE + route, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    }, function () { return null; });
  }

  function wordsOf(answer) {
    if (answer && answer.body && typeof answer.body.error === 'string') return answer.body.error;
    return answer ? 'Nexus answered ' + answer.status + '.' : CANT_REACH;
  }

  // The answer card, with the one mark that says how it went (none for a fault Nexus put in its own words).
  function showResult(words, mark) {
    slab(words);
    ask.hidden = true;
    Object.keys(MARKS).forEach(function (name) { MARKS[name].hidden = name !== mark; });
    said.textContent = words.said;
    quiet.textContent = words.quiet || '';
    quiet.hidden = !words.quiet;
    result.hidden = false;
  }

  // A refusal Nexus gave for the code itself: the card for a code that ran out or was used, or null when the refusal is
  // some other kind (the owner is not signed in, a code is missing) and Nexus's own words are shown instead.
  function finishedKind(answer) {
    if (!answer) return null;
    if (answer.status === 404) return 'used';
    if (answer.status === 410 && answer.body && (answer.body.reason === 'expired' || answer.body.reason === 'used')) return answer.body.reason;
    return null;
  }

  function showFinished(kind) {
    showResult(WORDS[kind], kind);
  }

  // Nexus's own words, on a card with the red cross, for what the boards do not draw.
  function showFault(words) {
    showResult({ title: WORDS.fault.title, line: WORDS.fault.line, said: words }, 'used');
  }

  // The minutes left on the code, from the expiry Nexus sent (never fewer than one while Nexus still says it is waiting).
  function minutesLeft(expiresAt) {
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / MINUTE));
  }

  // The device's code, one box per character, in groups of four so it can be matched against the device's own screen.
  function showCode(raw) {
    var characters = String(raw).replace(/[^A-Za-z0-9]/g, '').split('');
    codeBoxes.setAttribute('aria-label', 'Device code ' + characters.join(''));
    for (var start = 0; start < characters.length; start += GROUP) {
      var chunk = characters.slice(start, start + GROUP);
      var group = document.createElement('div');
      group.className = 'code__group code__group--of-' + chunk.length;
      chunk.forEach(function (character) {
        var box = document.createElement('div');
        box.className = 'code__box';
        box.textContent = character;
        group.appendChild(box);
      });
      codeBoxes.appendChild(group);
    }
  }

  function showQuestion(found) {
    asked = found;
    slab(WORDS.asking);
    question.textContent = 'Allow ' + found.label + ' to use Nexus as ' + found.identity + '?';
    var minutes = typeof found.expiresAt === 'number' ? minutesLeft(found.expiresAt) : null;
    hint.textContent = 'Only allow it if you just asked for it.' +
      (minutes === null ? '' : ' The code stops working in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.'));
    showCode(typeof found.code === 'string' ? found.code : code);
    ask.hidden = false;
    result.hidden = true;
    alertBox.hidden = true;
  }

  function answer(route) {
    setBusy(true);
    alertBox.hidden = true;
    call('POST', route, { code: code }).then(function (reply) {
      if (reply && reply.ok) {
        var allowed = route === 'approve';
        showResult({
          title: allowed ? WORDS.allowed.title : WORDS.denied.title,
          line: allowed ? WORDS.allowed.line : WORDS.denied.line,
          said: asked.label + (allowed ? ' can use Nexus now.' : ' was not given a token.'),
          quiet: allowed ? WORDS.allowed.quiet : WORDS.denied.quiet,
        }, allowed ? 'allowed' : 'denied');
        return;
      }
      var kind = finishedKind(reply);
      if (kind) {
        showFinished(kind);
      } else {
        alertBox.textContent = wordsOf(reply);
        alertBox.hidden = false;
        setBusy(false);
      }
    });
  }

  allowButton.addEventListener('click', function () { answer('approve'); });
  denyButton.addEventListener('click', function () { answer('deny'); });

  if (!code) {
    showFault(NO_CODE);
    return;
  }
  slab(WORDS.checking);
  call('GET', 'pending?code=' + encodeURIComponent(code)).then(function (reply) {
    if (reply && reply.ok && reply.body && typeof reply.body.label === 'string' && typeof reply.body.identity === 'string') {
      showQuestion(reply.body);
      return;
    }
    var kind = finishedKind(reply);
    if (kind) showFinished(kind);
    else showFault(wordsOf(reply));
  });
})();
