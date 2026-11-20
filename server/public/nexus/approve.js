// The device approval page. It reads the code from its own address, asks Nexus what is being asked, and lets the owner
// allow or deny it. A browser that is not signed in as the owner is first asked for the owner secret, on the page. Everything a device sent (its label, its identity, its code) goes on the page as text, never as
// markup: this file only sets text and shows or hides parts of the page, and builds nothing from what it was sent but
// plain boxes holding one character each.
//
//   GET  /nexus/api/device/pending?code=C    what is being asked, or a refusal
//   POST /nexus/api/device/approve { code }  Allow
//   POST /nexus/api/device/deny    { code }  Deny
//
// THE OWNER SECRET. Nexus answers 401 to all three until the owner is known. A browser that holds the owner's cookie is known
// already. For one that does not (a first device is set up with no Terminal), the page shows one field, and what the owner types
// goes to Nexus in the header x-nexus-owner-secret with each of those calls, as the Terminal's `allow` sends it in a cookie. It is
// sent over a secure connection only (window.isSecureContext), it is held in one variable of this script and nowhere else (no
// storage, no cookie, nothing on the page: the field is emptied as it is sent), and it is dropped as soon as the code has an answer.
//
// What the page shows:
//   the owner secret, when nobody is signed in
//   the question, the device's code and Allow and Deny
//   allowed                      denied
//   code ran out                 code used
// A refusal that says the code is finished takes the question away, so nothing can be tapped twice: a 410 says why in
// its `reason` (expired is "code ran out", used is "code used") and a 404 (a code Nexus no longer has) is "code used".
// Each of the two cards says it in Nexus's own words ("That code has run out." / "That code was already used."): the page
// shows what the 410 said. Any other refusal, and a code missing from the address, is shown in Nexus's own words.
(function () {
  'use strict';

  var DEVICE = '/nexus/api/device/';
  var MINUTE = 60 * 1000;
  var GROUP = 4;
  // The header the owner secret is sent in. The server's sign-in reads the same name (plugs/cloudflare/signin.ts).
  var OWNER_SECRET_HEADER = 'x-nexus-owner-secret';

  // The words, in one place. Nexus is not told which app a device is, so the page says "the device" and the label the
  // device sent names it in the card.
  var WORDS = {
    checking: { title: 'new device', line: 'Checking the code…' },
    asking: { title: 'new device', line: 'A device wants to sign in.' },
    owner: { title: 'new device', line: 'Only the owner can answer a device.' },
    allowed: { title: 'allowed', line: 'The device is in.', quiet: 'You can close this page. The device does the rest.' },
    denied: { title: 'denied', line: 'Nothing was shared.', quiet: 'Changed your mind? Start again from the device.' },
    expired: { title: 'code ran out', line: 'Ten minutes is up.', said: 'That code has run out.', quiet: 'Ask for a new one on the device.' },
    used: { title: 'code used', line: 'One answer per code.', said: 'That code was already used.', quiet: 'A code works once. Ask for a new one on the device.' },
    fault: { title: 'new device', line: 'That did not work.' },
  };
  var CANT_REACH = 'Nexus could not be reached. Check the connection and try again.';
  var WRONG_SECRET = 'That is not the owner secret.';
  var NO_SECRET = 'Type the owner secret first.';
  var NOT_SECURE = 'Open this page over a secure connection (https) to type the owner secret.';
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
  var owner = byId('owner');
  var ownerForm = byId('owner-form');
  var secretField = byId('secret');
  var ownerAlert = byId('owner-alert');
  var ownerGo = byId('owner-go');
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
  // The owner secret the owner typed, until the code is answered. The one place it is held.
  var ownerSecret = null;

  function slab(words) {
    title.textContent = words.title;
    line.textContent = words.line;
  }

  function setBusy(busy) {
    allowButton.disabled = busy;
    denyButton.disabled = busy;
  }

  // The field for the owner secret, with no answer on the page yet. `words` says what was wrong with the last try, if anything.
  function showOwner(words) {
    slab(WORDS.owner);
    ask.hidden = true;
    result.hidden = true;
    owner.hidden = false;
    var secure = window.isSecureContext === true;
    secretField.disabled = !secure;
    ownerGo.disabled = !secure;
    var problem = secure ? words : NOT_SECURE;
    ownerAlert.textContent = problem || '';
    ownerAlert.hidden = !problem;
    if (problem) secretField.setAttribute('aria-invalid', 'true');
    else secretField.removeAttribute('aria-invalid');
    if (secure) secretField.focus();
  }

  // Asks Nexus and hands back { ok, status, body }, or null when Nexus could not be reached.
  function call(method, route, body) {
    var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (ownerSecret !== null) options.headers[OWNER_SECRET_HEADER] = ownerSecret;
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
    ownerSecret = null;
    slab(words);
    ask.hidden = true;
    owner.hidden = true;
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

  // The card for a code that ran out or was used. It says it in the words Nexus sent with the 410, and in the page's own (the
  // WORDS above) only when Nexus sent none: a 404 has other words, for a code Nexus no longer has, and the card is "code used".
  function showFinished(kind, answer) {
    var words = WORDS[kind];
    if (answer.status === 410 && answer.body && typeof answer.body.error === 'string' && answer.body.error !== '') {
      words = { title: words.title, line: words.line, said: answer.body.error, quiet: words.quiet };
    }
    showResult(words, kind);
  }

  // Nexus's own words, on a card with the red cross, for what has no card of its own.
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
    owner.hidden = true;
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
      if (reply && reply.status === 401) {
        // The sign-in no longer works (the owner secret was changed, or this browser's cookie is gone): ask again.
        var heldOne = ownerSecret !== null;
        ownerSecret = null;
        showOwner(heldOne ? WRONG_SECRET : null);
      } else if (kind) {
        showFinished(kind, reply);
      } else {
        alertBox.textContent = wordsOf(reply);
        alertBox.hidden = false;
        setBusy(false);
      }
    });
  }

  allowButton.addEventListener('click', function () { answer('approve'); });
  denyButton.addEventListener('click', function () { answer('deny'); });

  // Asks what is being asked, and shows the question, a card for a code that is finished, the field for the owner secret when Nexus
  // does not know who is asking, or Nexus's own words.
  function load() {
    slab(WORDS.checking);
    call('GET', 'pending?code=' + encodeURIComponent(code)).then(function (reply) {
      if (reply && reply.ok && reply.body && typeof reply.body.label === 'string' && typeof reply.body.identity === 'string') {
        showQuestion(reply.body);
        return;
      }
      if (reply && reply.status === 401) {
        var wrong = ownerSecret !== null;
        ownerSecret = null;
        showOwner(wrong ? WRONG_SECRET : null);
        return;
      }
      var kind = finishedKind(reply);
      if (kind) showFinished(kind, reply);
      else showFault(wordsOf(reply));
    });
  }

  ownerForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (window.isSecureContext !== true) return;
    var typed = secretField.value.trim();
    if (typed === '') {
      showOwner(NO_SECRET);
      return;
    }
    // The field is emptied as the secret goes: it is held in `ownerSecret` and nowhere else.
    ownerSecret = typed;
    secretField.value = '';
    ownerGo.disabled = true;
    // The last try's fault is not shown beside this one.
    ownerAlert.hidden = true;
    secretField.removeAttribute('aria-invalid');
    load();
  });

  if (!code) {
    showFault(NO_CODE);
    return;
  }
  load();
})();
