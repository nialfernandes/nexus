// The Nexus page, the owner's own. It shows who is connected (the owner first, then each agent, each with its devices), the devices
// waiting to be let in (with Allow and Deny), a way to add an agent, and Remove for a device or an agent. A browser that is not
// signed in as the owner is first asked for the owner secret, on the page, and shown nothing else. Everything Nexus sent (a name, a
// label, a code, its own words for a refusal) goes on the page as text, never as markup: this file only sets text, shows or hides
// parts of the page, and builds plain rows, buttons and boxes from what it was sent.
//
//   GET  /nexus/api/identities                     who is connected: { identities: [ { name, kind, owner, createdAt, devices: [ { id, label, createdAt, lastUsedAt } ] } ] }
//   GET  /nexus/api/device/waiting                 the sign-ins waiting: { signins: [ { label, code, deviceKey } ] }
//   GET  /nexus/api/device/pending?code=C          for one of them: who it asks to be, and the code its device shows
//   POST /nexus/api/device/approve { code }        Allow
//   POST /nexus/api/device/deny    { code }        Deny
//   POST /nexus/api/identity { name, kind }        add an agent (kind is always agent here)
//   POST /nexus/api/identity/remove { name }       remove an agent and every device it has: { result: "removed", name, revoked }
//   POST /nexus/api/token/revoke { id }            remove a device: { result: "revoked", id }
//
// THE OWNER SECRET works as on the approval page (approve.js). Nexus answers 401 until the owner is known. A browser that holds the
// owner's cookie is known already. For one that does not, the page shows one field, and what the owner types goes to Nexus in the header
// x-nexus-owner-secret with each call. It is sent over a secure connection only (window.isSecureContext), it is held in one variable of
// this script and nowhere else (no storage, no cookie, nothing on the page: the field is emptied as it is sent). This page makes many
// calls over some minutes, so unlike the approval page's one answer the secret is held until Nexus refuses it or the page is closed.
//
// REMOVING takes the row off the page at once and starts a short wait (UNDO_MS) with Undo beside it. Undo puts the row back and
// nothing is sent. The call goes to Nexus only when the wait has passed. A page closed inside the wait sends nothing, so nothing is removed.
//
// A DEVICE WAITING is shown as the approval page shows it: its name, who it asks to be, and the code the device shows on its own screen
// to compare (its key's code, or its sign-in code for a device that sent no key). The list is asked for again every few seconds.
//
// Every refusal is shown in Nexus's own words, as it sent them.
(function () {
  'use strict';

  var API = '/nexus/api/';
  // The header the owner secret is sent in. The server's sign-in reads the same name (plugs/cloudflare/signin.ts).
  var OWNER_SECRET_HEADER = 'x-nexus-owner-secret';
  // How long a removal waits for Undo, how often the waiting list is asked for again, and how long Copy says it copied.
  var UNDO_MS = 8000;
  var WAITING_EVERY_MS = 5000;
  var COPIED_MS = 2000;
  // The kind of identity this page makes, and the only kind it removes (the owner is never removed here).
  var AGENT = 'agent';
  // What the agent runs: the name of the environment variable the command reads (packages/agent/src/cli/labels.ts, ENV.address) and the
  // command that signs it in (packages/agent/src/cli/main.ts, sign-in --identity <name> --label <label>).
  var ADDRESS_VARIABLE = 'NEXUS_ADDRESS';
  var SIGN_IN_COMMAND = 'nexus-agent sign-in';

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The words, in one place. Anything Nexus says in its own words is shown as it said it.
  var CHECKING = 'Checking who is connected…';
  var SIGNED_IN = 'Who can use Nexus.';
  var OWNER_ONLY = 'Only the owner can see this.';
  var CANT_REACH = 'Nexus could not be reached. Check the connection and try again.';
  var WRONG_SECRET = 'That is not the owner secret.';
  var NO_SECRET = 'Type the owner secret first.';
  var NOT_SECURE = 'Open this page over a secure connection (https) to type the owner secret.';
  var NEVER = 'never';
  var NOT_COPIED = 'That did not copy. Select the command and copy it.';

  function byId(id) { return document.getElementById(id); }
  var line = byId('line');
  var alertBox = byId('alert');
  var owner = byId('owner');
  var ownerForm = byId('owner-form');
  var secretField = byId('secret');
  var ownerAlert = byId('owner-alert');
  var ownerGo = byId('owner-go');
  var signedIn = byId('signed-in');
  var waitingList = byId('waiting');
  var people = byId('people');
  var nobody = byId('nobody');
  var addForm = byId('add-form');
  var nameField = byId('agent-name');
  var addGo = byId('add-go');
  var addAlert = byId('add-alert');
  var command = byId('command');
  var commandText = byId('command-text');
  var copyButton = byId('copy');
  var undoList = byId('undo');

  // The owner secret the owner typed. The one place it is held.
  var ownerSecret = null;
  // What Nexus last said about who is connected.
  var identities = [];
  // The sign-ins waiting, as the page shows them, and the codes they were last drawn for.
  var waiting = [];
  var waitingDrawn = '';
  // What Nexus said about each waiting code (who it asks to be, the code to compare), so each is asked about once.
  var asked = {};
  // The removals not finished: each is hidden from the page, and each not yet sent has a timer and an Undo.
  var removals = [];
  var polling = null;
  var copiedTimer = null;
  // Counts the times the page went back to asking for the owner secret, so an answer that arrives after that is not drawn.
  var session = 0;

  // ── asking Nexus ───────────────────────────────────────────────────────────

  // Asks Nexus and hands back { ok, status, body }, or null when Nexus could not be reached.
  function call(method, route, body) {
    var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (ownerSecret !== null) options.headers[OWNER_SECRET_HEADER] = ownerSecret;
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(API + route, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    }, function () { return null; });
  }

  // Nexus's own words for a refusal, or ours when Nexus sent none.
  function wordsOf(answer) {
    if (answer && answer.body && typeof answer.body.error === 'string' && answer.body.error !== '') return answer.body.error;
    return answer ? 'Nexus answered ' + answer.status + '.' : CANT_REACH;
  }

  // Whether Nexus does not know who is asking (the owner is not signed in, or the secret was wrong).
  function notSignedIn(answer) {
    return answer !== null && (answer.status === 401 || answer.status === 403);
  }

  // ── what is shown ──────────────────────────────────────────────────────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function say(box, words) {
    box.textContent = words || '';
    box.hidden = !words;
  }

  function pad(number) { return (number < 10 ? '0' : '') + number; }

  // A time as "Sat 12 Sep · 12:00", in the browser's own time zone.
  function when(ms) {
    var date = new Date(ms);
    return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()] + ' · ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // The field for the owner secret, and nothing else on the page. `words` says what was wrong with the last try, if anything. Whatever
  // Nexus had said is taken off the page, so a browser that is not signed in is left with nothing of it.
  function showOwner(words) {
    session += 1;
    stopPolling();
    identities = [];
    waiting = [];
    waitingDrawn = '';
    asked = {};
    removals.forEach(function (removal) { clearTimeout(removal.timer); });
    removals = [];
    people.textContent = '';
    waitingList.textContent = '';
    undoList.textContent = '';
    command.hidden = true;
    commandText.textContent = '';
    say(alertBox, '');
    say(addAlert, '');
    signedIn.hidden = true;
    line.textContent = OWNER_ONLY;
    owner.hidden = false;
    var secure = window.isSecureContext === true;
    secretField.disabled = !secure;
    ownerGo.disabled = !secure;
    var problem = secure ? words : NOT_SECURE;
    say(ownerAlert, problem);
    if (problem) secretField.setAttribute('aria-invalid', 'true');
    else secretField.removeAttribute('aria-invalid');
    if (secure) secretField.focus();
  }

  // Nexus refused the owner mid-way: ask for the secret again, and say it was wrong if one was held.
  function askAgain(answer) {
    var held = ownerSecret !== null;
    ownerSecret = null;
    showOwner(held ? WRONG_SECRET : answer.status === 403 ? wordsOf(answer) : null);
  }

  function showSignedIn() {
    owner.hidden = true;
    signedIn.hidden = false;
    line.textContent = SIGNED_IN;
  }

  // ── who is connected ───────────────────────────────────────────────────────

  function removeButton(name, onTap) {
    var button = el('button', 'pill pill--quiet pill--small', 'Remove');
    button.type = 'button';
    button.setAttribute('aria-label', 'Remove ' + name);
    button.addEventListener('click', onTap);
    return button;
  }

  // Whether a removal not yet finished hides this agent or this device.
  function hidden(kind, key) {
    return removals.some(function (removal) { return removal.kind === kind && removal.key === key; });
  }

  function deviceRow(person, device) {
    var row = el('li', 'device');
    var text = el('div', 'device__text');
    text.appendChild(el('p', 'device__label', device.label));
    text.appendChild(el('p', 'device__when', 'Added ' + when(device.createdAt)));
    text.appendChild(el('p', 'device__when', 'Last used ' + (typeof device.lastUsedAt === 'number' ? when(device.lastUsedAt) : NEVER)));
    row.appendChild(text);
    row.appendChild(removeButton(device.label, function () { removeDevice(device); }));
    return row;
  }

  function personRow(person) {
    var row = el('li', 'person');
    var head = el('div', 'person__head');
    head.appendChild(el('span', 'person__name', person.name));
    head.appendChild(el('span', 'tag', person.owner ? 'owner' : person.kind));
    if (!person.owner && person.kind === AGENT) head.appendChild(removeButton(person.name, function () { removeAgent(person); }));
    row.appendChild(head);
    var devices = (person.devices || []).filter(function (device) { return !hidden('device', device.id); });
    if (devices.length === 0) {
      row.appendChild(el('p', 'card__quiet', 'No devices.'));
    } else {
      var list = el('ul', 'devices');
      devices.forEach(function (device) { list.appendChild(deviceRow(person, device)); });
      row.appendChild(list);
    }
    return row;
  }

  // The owner first, then the rest as Nexus listed them.
  function inOrder(list) {
    return list.filter(function (person) { return person.owner; }).concat(list.filter(function (person) { return !person.owner; }));
  }

  function renderPeople() {
    var shown = inOrder(identities).filter(function (person) { return !hidden('agent', person.name); });
    people.textContent = '';
    shown.forEach(function (person) { people.appendChild(personRow(person)); });
    nobody.hidden = shown.length > 0;
  }

  function renderUndo() {
    undoList.textContent = '';
    var waitingOnUndo = removals.filter(function (removal) { return !removal.sent; });
    waitingOnUndo.forEach(function (removal) {
      var item = el('li', 'undo__item');
      item.appendChild(el('p', 'undo__words', removal.words));
      var undo = el('button', 'pill pill--quiet pill--small', 'Undo');
      undo.type = 'button';
      undo.setAttribute('aria-label', 'Undo ' + removal.words);
      undo.addEventListener('click', function () { undoRemoval(removal); });
      item.appendChild(undo);
      undoList.appendChild(item);
    });
    undoList.hidden = waitingOnUndo.length === 0;
  }

  function render() {
    renderPeople();
    renderUndo();
  }

  // Asks who is connected. Hands back the answer, so the first ask can decide what the page shows.
  function loadIdentities() {
    var mine = session;
    return call('GET', 'identities').then(function (reply) {
      if (mine === session && reply && reply.ok && reply.body && Array.isArray(reply.body.identities)) {
        identities = reply.body.identities;
        render();
      }
      return reply;
    });
  }

  // ── removing, with Undo ────────────────────────────────────────────────────

  function startRemoval(removal) {
    say(alertBox, '');
    removals.push(removal);
    removal.timer = setTimeout(function () { sendRemoval(removal); }, UNDO_MS);
    render();
  }

  function removeAgent(person) {
    startRemoval({ kind: 'agent', key: person.name, words: person.name + ' removed.', route: 'identity/remove', body: { name: person.name }, sent: false, timer: null });
  }

  function removeDevice(device) {
    startRemoval({ kind: 'device', key: device.id, words: device.label + ' removed.', route: 'token/revoke', body: { id: device.id }, sent: false, timer: null });
  }

  // Undo: the row comes back, and nothing was ever sent.
  function undoRemoval(removal) {
    clearTimeout(removal.timer);
    removals = removals.filter(function (other) { return other !== removal; });
    render();
  }

  // The wait is over: now, and only now, Nexus is told. The row stays off the page until Nexus has answered.
  function sendRemoval(removal) {
    removal.sent = true;
    renderUndo();
    call('POST', removal.route, removal.body).then(function (reply) {
      removals = removals.filter(function (other) { return other !== removal; });
      if (reply && reply.ok) {
        if (removal.kind === 'agent') {
          identities = identities.filter(function (person) { return person.name !== removal.key; });
        } else {
          identities.forEach(function (person) {
            person.devices = (person.devices || []).filter(function (device) { return device.id !== removal.key; });
          });
        }
        render();
        loadIdentities();
        return;
      }
      render();
      if (reply && notSignedIn(reply)) {
        askAgain(reply);
        return;
      }
      // Nexus said no (or could not be reached): its words, and the row is back only if Nexus still has it.
      say(alertBox, wordsOf(reply));
      loadIdentities();
    });
  }

  // ── devices waiting ────────────────────────────────────────────────────────

  function stripFor(entry) {
    var item = el('li', 'strip');
    item.appendChild(el('p', 'strip__words', entry.label + ' wants to sign in as ' + entry.identity + '.'));
    item.appendChild(el('p', 'strip__code', entry.shown));
    var actions = el('div', 'actions');
    var allow = el('button', 'pill pill--main', 'Allow');
    var deny = el('button', 'pill pill--quiet', 'Deny');
    allow.type = 'button';
    deny.type = 'button';
    allow.setAttribute('aria-label', 'Allow ' + entry.label);
    deny.setAttribute('aria-label', 'Deny ' + entry.label);
    allow.addEventListener('click', function () { answer(entry, 'approve', allow, deny); });
    deny.addEventListener('click', function () { answer(entry, 'deny', allow, deny); });
    actions.appendChild(allow);
    actions.appendChild(deny);
    item.appendChild(actions);
    return item;
  }

  function renderWaiting() {
    var drawn = waiting.map(function (entry) { return entry.code; }).join('|');
    // Drawn again only when the list changed, so a button is not rebuilt under a finger.
    if (drawn === waitingDrawn) return;
    waitingDrawn = drawn;
    waitingList.textContent = '';
    waiting.forEach(function (entry) { waitingList.appendChild(stripFor(entry)); });
    waitingList.hidden = waiting.length === 0;
  }

  // What Nexus says about one waiting code, or null when it is gone by now. Asked once per code.
  function aboutCode(signin) {
    if (asked[signin.code]) return Promise.resolve(asked[signin.code]);
    return call('GET', 'device/pending?code=' + encodeURIComponent(signin.code)).then(function (reply) {
      if (!reply || !reply.ok || !reply.body || typeof reply.body.identity !== 'string') return null;
      var about = {
        code: signin.code,
        label: typeof reply.body.label === 'string' ? reply.body.label : signin.label,
        identity: reply.body.identity,
        // The code the device shows for its key; for a device with no key, its sign-in code.
        shown: typeof reply.body.deviceCode === 'string' && reply.body.deviceCode !== '' ? reply.body.deviceCode : signin.code,
      };
      asked[signin.code] = about;
      return about;
    });
  }

  function loadWaiting() {
    var mine = session;
    return call('GET', 'device/waiting').then(function (reply) {
      if (mine !== session) return;
      if (reply && notSignedIn(reply)) {
        askAgain(reply);
        return;
      }
      if (!reply || !reply.ok || !reply.body || !Array.isArray(reply.body.signins)) return;
      return Promise.all(reply.body.signins.map(aboutCode)).then(function (entries) {
        // The owner may have been asked for the secret again while Nexus was answering.
        if (mine !== session) return;
        waiting = entries.filter(function (entry) { return entry !== null; });
        renderWaiting();
      });
    });
  }

  // Allow or Deny: sent as the approval page sends it. A code that is finished (ran out, used) is taken off the page and Nexus's words shown.
  function answer(entry, route, allow, deny) {
    allow.disabled = true;
    deny.disabled = true;
    say(alertBox, '');
    call('POST', 'device/' + route, { code: entry.code }).then(function (reply) {
      if (reply && reply.ok) {
        waiting = waiting.filter(function (other) { return other !== entry; });
        renderWaiting();
        line.textContent = route === 'approve' ? entry.label + ' can use Nexus now.' : entry.label + ' was not given a token.';
        if (route === 'approve') loadIdentities();
        return;
      }
      if (reply && notSignedIn(reply)) {
        askAgain(reply);
        return;
      }
      if (reply && (reply.status === 404 || reply.status === 410)) {
        waiting = waiting.filter(function (other) { return other !== entry; });
        renderWaiting();
      } else {
        allow.disabled = false;
        deny.disabled = false;
      }
      say(alertBox, wordsOf(reply));
    });
  }

  function stopPolling() {
    if (polling !== null) clearInterval(polling);
    polling = null;
  }

  function startPolling() {
    if (polling === null) polling = setInterval(loadWaiting, WAITING_EVERY_MS);
  }

  // ── adding an agent ────────────────────────────────────────────────────────

  // The one command to run on the agent: it signs the agent in as its identity, and the sign-in then waits above for Allow. The address is
  // the one this page was opened at.
  function commandFor(name) {
    return ADDRESS_VARIABLE + '=' + window.location.origin + '/nexus/api ' + SIGN_IN_COMMAND + ' --identity ' + name + ' --label ' + name;
  }

  addForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var typed = nameField.value.trim();
    addGo.disabled = true;
    say(addAlert, '');
    call('POST', 'identity', { name: typed, kind: AGENT }).then(function (reply) {
      addGo.disabled = false;
      if (reply && reply.ok && reply.body && typeof reply.body.name === 'string') {
        nameField.value = '';
        commandText.textContent = commandFor(reply.body.name);
        copyButton.textContent = 'Copy';
        command.hidden = false;
        line.textContent = reply.body.name + ' added.';
        loadIdentities();
        return;
      }
      if (reply && notSignedIn(reply)) askAgain(reply);
      else say(addAlert, wordsOf(reply));
    });
  });

  copyButton.addEventListener('click', function () {
    var text = commandText.textContent;
    var copied = typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('no clipboard'));
    copied.then(function () {
      say(addAlert, '');
      copyButton.textContent = 'Copied';
      if (copiedTimer !== null) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(function () { copyButton.textContent = 'Copy'; }, COPIED_MS);
    }, function () { say(addAlert, NOT_COPIED); });
  });

  // ── start ──────────────────────────────────────────────────────────────────

  // Asks who is connected, and shows the page for the owner, the field for the owner secret when Nexus does not know who is asking, or
  // Nexus's own words.
  function load() {
    line.textContent = CHECKING;
    loadIdentities().then(function (reply) {
      if (reply && reply.ok && reply.body && Array.isArray(reply.body.identities)) {
        showSignedIn();
        loadWaiting();
        startPolling();
        return;
      }
      if (reply && notSignedIn(reply)) {
        askAgain(reply);
        return;
      }
      line.textContent = wordsOf(reply);
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
    say(ownerAlert, '');
    secretField.removeAttribute('aria-invalid');
    load();
  });

  load();
})();
