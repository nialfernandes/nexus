// The device approval page. It reads the code from its own address, asks Nexus what is being asked, and lets the
// owner allow or deny it. Everything a device sent (its label, the identity) goes on the page as text, never as markup.
//
//   GET  /nexus/api/device/pending?code=C    what is being asked, or a refusal in plain words
//   POST /nexus/api/device/approve { code }  Allow
//   POST /nexus/api/device/deny    { code }  Deny
//
// A refusal's own words are shown as they come (an expired code, a code nobody was given). A refusal that says the
// code is finished (404 or 410) takes the buttons away, so nothing can be tapped twice.
(function () {
  'use strict';

  var DEVICE = '/nexus/api/device/';
  var CANT_REACH = 'Nexus could not be reached. Check the connection and try again.';
  var NO_CODE = 'This link has no code in it. Open the link the device gave you.';

  function byId(id) { return document.getElementById(id); }
  var question = byId('question');
  var hint = byId('hint');
  var actions = byId('actions');
  var allowButton = byId('allow');
  var denyButton = byId('deny');
  var status = byId('status');
  var alertBox = byId('alert');

  var code = new URLSearchParams(window.location.search).get('code');
  // What the device asked for, kept once Nexus has said so, to name it in the answer.
  var asked = null;

  function say(box, words) {
    var other = box === status ? alertBox : status;
    other.hidden = true;
    box.textContent = words;
    box.hidden = false;
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

  // The code is finished: it is not there, or it has been used or has expired.
  function finished(answer) {
    return !!answer && (answer.status === 404 || answer.status === 410);
  }

  function showQuestion(found) {
    asked = found;
    question.textContent = 'Allow ' + found.label + ' to use Nexus as ' + found.identity + '?';
    question.hidden = false;
    hint.hidden = false;
    actions.hidden = false;
    status.hidden = true;
  }

  function answer(route) {
    setBusy(true);
    say(status, 'Sending your answer…');
    call('POST', route, { code: code }).then(function (reply) {
      if (reply && reply.ok) {
        question.hidden = true;
        hint.hidden = true;
        actions.hidden = true;
        var who = asked.label + ' as ' + asked.identity;
        say(status, route === 'approve'
          ? 'Allowed. ' + who + ' can use Nexus now.'
          : 'Denied. ' + who + ' was not given a token.');
        return;
      }
      say(alertBox, wordsOf(reply));
      if (finished(reply)) {
        question.hidden = true;
        hint.hidden = true;
        actions.hidden = true;
      } else {
        setBusy(false);
      }
    });
  }

  allowButton.addEventListener('click', function () { answer('approve'); });
  denyButton.addEventListener('click', function () { answer('deny'); });

  if (!code) {
    say(alertBox, NO_CODE);
    return;
  }
  say(status, 'Checking the code…');
  call('GET', 'pending?code=' + encodeURIComponent(code)).then(function (reply) {
    if (reply && reply.ok && reply.body && typeof reply.body.label === 'string' && typeof reply.body.identity === 'string') {
      showQuestion(reply.body);
    } else {
      say(alertBox, wordsOf(reply));
    }
  });
})();
