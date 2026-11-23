// The Nexus page, the owner's own, as drawn on boards 26 to 30 (docs/design/nexus-page). It shows one view at a time: who is connected
// (the owner as "you", then each agent, each with its devices, and a strip for each device waiting to be let in, with Allow and Deny),
// adding an agent (its name, then the one command to run on it, then that it has joined), one agent (its devices and Remove agent), and
// Settings (Sign out). A browser that is not signed in as the owner is first asked for the owner secret, on the page, and shown nothing
// else. Everything Nexus sent (a name, a label, a code, its own words for a refusal) goes on the page as text, never as markup: this
// file only sets text, shows or hides parts of the page, and builds plain rows, buttons and boxes from what it was sent.
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
// calls over some minutes, so unlike the approval page's one answer the secret is held until Nexus refuses it, Sign out lets it go, or
// the page is closed. Sign out does not reach a cookie: Nexus has no route that takes the owner's cookie away.
//
// REMOVING takes the row off the page at once and starts a short wait (UNDO_MS) with Undo beside it. Undo puts the row back and
// nothing is sent. The call goes to Nexus only when the wait has passed. A page closed inside the wait sends nothing, so nothing is removed.
//
// A DEVICE WAITING is shown as a strip: its name and that it wants in (and as whom, when it is not the owner), and the code the device
// shows on its own screen to compare (its key's code, or its sign-in code for a device that sent no key). A device has Allow and Deny. A
// sign-in as an AGENT has Deny only and says where the key is given (board 28a): an agent is let in in Obsidian, where the key goes with it,
// never here. The list is asked for again every few seconds. After an agent is added, who is connected is asked for again too, until the
// agent has a working device.
//
// THE KEY is never on this page: it is given in Obsidian. The page has no key, no place to type one and no button for it.
//
// Every refusal is shown in Nexus's own words, as it sent them, except a name that is taken, which is shown in the words drawn on board 27a.
(function () {
  'use strict';

  var API = '/nexus/api/';
  // The header the owner secret is sent in. The server's sign-in reads the same name (plugs/cloudflare/signin.ts).
  var OWNER_SECRET_HEADER = 'x-nexus-owner-secret';
  // How long a removal waits for Undo, how often the page asks again (the devices waiting, and an agent that has not joined), and how
  // long Copy says it copied.
  var UNDO_MS = 8000;
  var ASK_AGAIN_MS = 5000;
  var COPIED_MS = 2000;
  // The kind of identity this page makes, and the only kind it removes (the owner is never removed here).
  var AGENT = 'agent';
  // What the agent runs (packages/agent: the command that joins it to Nexus): `nexus-agent join <name> > <name>.env`, which keeps what the
  // command prints in a file named for the agent.
  var JOIN_COMMAND = 'nexus-agent join';
  var ENV_FILE_END = '.env';
  // A name is what Nexus accepts (identities.ts): lower case letters, digits and hyphens, first a letter or digit, at most 40 long.
  // Anything else is blocked as it is typed.
  var NAME_OK = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var NAME_BLOCKED = /[^a-z0-9-]/g;

  // The views, and the title each one has on the bar (an agent's view is titled by the agent's name).
  var CONNECTED = 'connected';
  var ADD = 'add';
  var AGENT_VIEW = 'agent';
  var SETTINGS = 'settings';
  var TITLES = { connected: 'connected', add: 'add an agent', settings: 'settings' };

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The words, in one place. Anything Nexus says in its own words is shown as it said it.
  var CHECKING = 'Checking who is connected…';
  var LEAD_LIST = 'Everything that can read your notes.';
  var LEAD_ADD = 'Give the agent a name. It reads every note once it has the key.';
  var OWNER_TITLE = 'you';
  var OWNER_ONLY = 'Only the owner can see this.';
  var CANT_REACH = 'Nexus could not be reached. Check the connection and try again.';
  var WRONG_SECRET = 'That is not the owner secret.';
  var NO_SECRET = 'Type the owner secret first.';
  var NOT_SECURE = 'Open this page over a secure connection (https) to type the owner secret.';
  var NEVER = 'never';
  var NOT_COPIED = 'That did not copy. Select the command and copy it.';
  var NAME_HINT = 'Lower case letters, digits and hyphens.';
  // Where an agent's key is given (board 28a): in Obsidian, never on this page.
  function keyInObsidian(name) { return 'Open Obsidian on your Mac to give ' + name + ' the key.'; }
  var NO_DEVICES = 'No devices.';

  function byId(id) { return document.getElementById(id); }
  var line = byId('line');
  var alertBox = byId('alert');
  var owner = byId('owner');
  var ownerForm = byId('owner-form');
  var secretField = byId('secret');
  var ownerAlert = byId('owner-alert');
  var ownerGo = byId('owner-go');
  var signedIn = byId('signed-in');
  var title = byId('title');
  var where = byId('where');
  var backButton = byId('back');
  var barActions = byId('slab-actions');
  var addOpen = byId('add-open');
  var appsLink = byId('apps');
  var askButton = byId('ask');
  var waitingList = byId('waiting');
  var viewConnected = byId('view-connected');
  var people = byId('people');
  var nobody = byId('nobody');
  var onlyYou = byId('only-you');
  var addFirst = byId('add-first');
  var viewAdd = byId('view-add');
  var addCard = byId('add-card');
  var addForm = byId('add-form');
  var nameField = byId('agent-name');
  var nameHint = byId('agent-hint');
  var addGo = byId('add-go');
  var addAlert = byId('add-alert');
  var command = byId('command');
  var commandText = byId('command-text');
  var copyButton = byId('copy');
  var waitingFor = byId('waiting-for');
  var joinedCard = byId('joined');
  var joinedTitle = byId('joined-title');
  var joinedWords = byId('joined-words');
  var viewAgent = byId('view-agent');
  var agentCard = byId('agent-card');
  var removeAgentButton = byId('remove-agent');
  var viewSettings = byId('view-settings');
  var signOutButton = byId('sign-out');
  var undoList = byId('undo');
  var tabConnected = byId('tab-connected');
  var tabSettings = byId('tab-settings');

  // The owner secret the owner typed. The one place it is held.
  var ownerSecret = null;
  // Whether Nexus knows who is asking: until it does, the page shows the owner card and nothing else.
  var known = false;
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
  // Which view is open, which agent the agent view is of, the agent just added (null before one is), whether it has a working device yet,
  // a line that stands in for the view's own line (what was just done, or what the page is waiting for), whether an add is out, and the
  // words that say the name typed is taken (null when it is not).
  var view = CONNECTED;
  var openAgent = null;
  var added = null;
  var joined = false;
  var notice = null;
  var adding = false;
  var takenWords = null;

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

  // A day as "Sat 21 Nov", and a time as "Mon 23 Nov · 11:40", in the browser's own time zone.
  function day(ms) {
    var date = new Date(ms);
    return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
  }

  function when(ms) {
    var date = new Date(ms);
    return day(ms) + ' · ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // The owner, then the rest as Nexus listed them.
  function inOrder(list) {
    return list.filter(function (person) { return person.owner; }).concat(list.filter(function (person) { return !person.owner; }));
  }

  // Whether a removal not yet finished hides this agent or this device.
  function hidden(kind, key) {
    return removals.some(function (removal) { return removal.kind === kind && removal.key === key; });
  }

  function visiblePeople() {
    return inOrder(identities).filter(function (person) { return !hidden('agent', person.name); });
  }

  function personNamed(name) {
    return visiblePeople().filter(function (person) { return person.name === name; })[0] || null;
  }

  function devicesOf(person) {
    return (person.devices || []).filter(function (device) { return !hidden('device', device.id); });
  }

  // The line under the bar, for the view that is open. Empty when the view has none.
  function viewLine() {
    if (view === CONNECTED) return stripsShown() ? '' : LEAD_LIST;
    if (view === ADD) {
      if (added === null) return LEAD_ADD;
      return joined ? added.name + ' has joined.' : added.name + ' is added. Run this on the agent.';
    }
    if (view === AGENT_VIEW) {
      var person = personNamed(openAgent);
      return person && typeof person.createdAt === 'number' ? 'Joined ' + day(person.createdAt) + '. It reads every note.' : 'It reads every note.';
    }
    return '';
  }

  function renderLine() {
    var words = notice !== null ? notice : viewLine();
    line.textContent = words;
    line.hidden = words === '';
  }

  // The bar: the title, the back chevron on the views that have one, the page action then the Ask sparkle (Settings has Aus Apps in place of
  // both), and which tab is open.
  function renderBar() {
    var back = known && (view === ADD || view === AGENT_VIEW);
    title.textContent = view === AGENT_VIEW && openAgent !== null ? openAgent : TITLES[view];
    where.className = back ? 'slab__where slab__where--back' : 'slab__where';
    backButton.hidden = !back;
    barActions.hidden = !known;
    addOpen.hidden = view !== CONNECTED;
    appsLink.hidden = view !== SETTINGS;
    askButton.hidden = view === SETTINGS;
    var onSettings = view === SETTINGS;
    tabConnected.className = onSettings ? 'tab' : 'tab tab--open';
    tabSettings.className = onSettings ? 'tab tab--open' : 'tab';
    if (onSettings) {
      tabConnected.removeAttribute('aria-current');
      tabSettings.setAttribute('aria-current', 'page');
    } else {
      tabSettings.removeAttribute('aria-current');
      tabConnected.setAttribute('aria-current', 'page');
    }
  }

  function renderViews() {
    viewConnected.hidden = view !== CONNECTED;
    viewAdd.hidden = view !== ADD;
    viewAgent.hidden = view !== AGENT_VIEW;
    viewSettings.hidden = view !== SETTINGS;
  }

  // The field for the owner secret, and nothing else on the page. `words` says what was wrong with the last try, if anything. Whatever
  // Nexus had said is taken off the page, so a browser that is not signed in is left with nothing of it.
  function showOwner(words) {
    session += 1;
    stopPolling();
    known = false;
    identities = [];
    waiting = [];
    waitingDrawn = '';
    asked = {};
    removals.forEach(function (removal) { clearTimeout(removal.timer); });
    removals = [];
    view = CONNECTED;
    openAgent = null;
    added = null;
    joined = false;
    adding = false;
    takenWords = null;
    people.textContent = '';
    agentCard.textContent = '';
    waitingList.textContent = '';
    undoList.textContent = '';
    nameField.value = '';
    commandText.textContent = '';
    say(alertBox, '');
    say(addAlert, '');
    signedIn.hidden = true;
    notice = OWNER_ONLY;
    renderBar();
    renderLine();
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
    known = true;
    owner.hidden = true;
    signedIn.hidden = false;
    notice = null;
    renderAll();
  }

  // Opens a view. What the last view said about what was just done is let go. Leaving the add view forgets the agent that was added.
  function openView(next, agentName) {
    view = next;
    openAgent = next === AGENT_VIEW ? agentName : null;
    if (next !== ADD) {
      added = null;
      joined = false;
    }
    notice = null;
    renderAll();
  }

  // ── who is connected ───────────────────────────────────────────────────────

  function removeButton(name, onTap) {
    var button = el('button', 'pill pill--quiet', 'Remove');
    button.type = 'button';
    button.setAttribute('aria-label', 'Remove ' + name);
    button.addEventListener('click', onTap);
    return button;
  }

  function deviceRow(device) {
    var row = el('li', 'device');
    var text = el('div', 'device__text');
    text.appendChild(el('p', 'device__label', device.label));
    // A time Nexus has not got yet (null) is left out rather than drawn as a broken date.
    if (typeof device.createdAt === 'number') text.appendChild(el('p', 'device__when', 'added ' + day(device.createdAt)));
    text.appendChild(el('p', 'device__when', 'last used ' + (typeof device.lastUsedAt === 'number' ? when(device.lastUsedAt) : NEVER)));
    row.appendChild(text);
    row.appendChild(removeButton(device.label, function () { removeDevice(device); }));
    return row;
  }

  // One card: the owner as "you" or the agent's name (on the list, an agent's name opens it), and its devices.
  function personCard(person, opens) {
    var card = el('li', 'person');
    if (!person.owner && person.kind === AGENT && opens) {
      var open = el('button', 'person__name person__open', person.name);
      open.type = 'button';
      open.addEventListener('click', function () { openView(AGENT_VIEW, person.name); });
      card.appendChild(open);
    } else {
      card.appendChild(el('h2', 'person__name', person.owner ? OWNER_TITLE : person.name));
    }
    var devices = devicesOf(person);
    if (devices.length === 0) {
      card.appendChild(el('p', 'card__quiet', NO_DEVICES));
    } else {
      var list = el('ul', 'devices');
      devices.forEach(function (device) { list.appendChild(deviceRow(device)); });
      card.appendChild(list);
    }
    return card;
  }

  function renderPeople() {
    var shown = visiblePeople();
    people.textContent = '';
    shown.forEach(function (person) { people.appendChild(personCard(person, true)); });
    nobody.hidden = shown.length > 0;
    // Board 26a: only the owner is here.
    onlyYou.hidden = shown.length === 0 || shown.some(function (person) { return !person.owner; });
    viewConnected.className = onlyYou.hidden ? 'view view--list' : 'view view--list view--only-you';
  }

  // Board 29: one agent. If it is gone (removed, or Nexus no longer lists it) the page is back on the list.
  function renderAgent() {
    agentCard.textContent = '';
    var person = view === AGENT_VIEW ? personNamed(openAgent) : null;
    if (view === AGENT_VIEW && person === null) {
      openView(CONNECTED);
      return;
    }
    if (person !== null) agentCard.appendChild(personCard(person, false));
  }

  // Whether the agent just added has a device that works: the page then says it has joined, in place of what was said about allowing it.
  function renderJoined() {
    if (added === null || joined) return;
    var person = personNamed(added.name);
    if (person && devicesOf(person).length > 0) {
      joined = true;
      notice = null;
    }
  }

  function renderAdd() {
    var form = added === null;
    addCard.hidden = !form;
    command.hidden = form || joined;
    joinedCard.hidden = form || !joined;
    if (!form) {
      joinedTitle.textContent = added.name + ' joined';
      joinedWords.textContent = keyInObsidian(added.name);
      waitingFor.textContent = 'waiting for ' + added.name;
    }
    renderName();
  }

  // The name field: Add is dim until the name is good and nothing is out, and a refused name turns the field and the line under it red.
  function renderName() {
    addGo.disabled = adding || takenWords !== null || !NAME_OK.test(nameField.value);
    nameHint.textContent = takenWords !== null ? takenWords : NAME_HINT;
    nameHint.className = takenWords !== null ? 'card__quiet card__quiet--taken' : 'card__quiet';
    if (takenWords !== null) nameField.setAttribute('aria-invalid', 'true');
    else nameField.removeAttribute('aria-invalid');
  }

  function renderUndo() {
    undoList.textContent = '';
    var waitingOnUndo = removals.filter(function (removal) { return !removal.sent; });
    waitingOnUndo.forEach(function (removal) {
      var item = el('li', 'undo__item');
      item.appendChild(el('p', 'undo__words', removal.words));
      var undo = el('button', 'undo__button', 'Undo');
      undo.type = 'button';
      undo.setAttribute('aria-label', 'Undo ' + removal.words);
      undo.addEventListener('click', function () { undoRemoval(removal); });
      item.appendChild(undo);
      undoList.appendChild(item);
    });
    undoList.hidden = waitingOnUndo.length === 0;
  }

  // Everything that depends on what Nexus last said or on the view that is open.
  function renderAll() {
    renderPeople();
    renderAgent();
    renderJoined();
    renderViews();
    renderAdd();
    renderUndo();
    renderWaiting();
    renderBar();
    renderLine();
  }

  // Asks who is connected. Hands back the answer, so the first ask can decide what the page shows.
  function loadIdentities() {
    var mine = session;
    return call('GET', 'identities').then(function (reply) {
      if (mine === session && reply && reply.ok && reply.body && Array.isArray(reply.body.identities)) {
        identities = reply.body.identities;
        renderAll();
      }
      return reply;
    });
  }

  // ── removing, with Undo ────────────────────────────────────────────────────

  function startRemoval(removal) {
    say(alertBox, '');
    removals.push(removal);
    removal.timer = setTimeout(function () { sendRemoval(removal); }, UNDO_MS);
    renderAll();
  }

  // Removing an agent from its own view puts the page back on the list, with the Undo bar above the tabs (board 29a).
  function removeAgent(person) {
    startRemoval({ kind: 'agent', key: person.name, words: person.name + ' removed, its devices stopped', route: 'identity/remove', body: { name: person.name }, sent: false, timer: null });
  }

  function removeDevice(device) {
    startRemoval({ kind: 'device', key: device.id, words: device.label + ' removed', route: 'token/revoke', body: { id: device.id }, sent: false, timer: null });
  }

  // Undo: the row comes back, and nothing was ever sent.
  function undoRemoval(removal) {
    clearTimeout(removal.timer);
    removals = removals.filter(function (other) { return other !== removal; });
    renderAll();
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
        renderAll();
        loadIdentities();
        return;
      }
      renderAll();
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

  // The strips show above the list, and above the agent just added while it waits to join (its own sign-in arrives here).
  function stripsShown() {
    return waiting.length > 0 && (view === CONNECTED || (view === ADD && added !== null && !joined));
  }

  // The name of the owner, as Nexus lists it ("" until it has).
  function ownerName() {
    var found = identities.filter(function (person) { return person.owner; })[0];
    return found ? found.name : '';
  }

  // Whether a sign-in is an agent's: the identity it asks to be is one Nexus lists as an agent. An agent is let in in Obsidian, where the key is
  // handed over with it, and not here: its strip has no Allow.
  function isAgentSignIn(identity) {
    return identities.some(function (person) { return person.name === identity && !person.owner && person.kind === AGENT; });
  }

  function stripFor(entry) {
    var item = el('li', 'strip');
    var text = el('div', 'strip__text');
    // "iPhone wants in" for the owner's own device; a device asking to be anyone else says who.
    text.appendChild(el('p', 'strip__words', entry.label + ' wants in' + (entry.identity === ownerName() ? '' : ' as ' + entry.identity)));
    text.appendChild(el('p', 'strip__code', entry.shown));
    var agent = isAgentSignIn(entry.identity);
    if (agent) text.appendChild(el('p', 'strip__key', keyInObsidian(entry.identity)));
    item.appendChild(text);
    var actions = el('div', 'actions');
    var allow = null;
    if (!agent) {
      allow = el('button', 'pill pill--main', 'Allow');
      allow.type = 'button';
      allow.setAttribute('aria-label', 'Allow ' + entry.label);
      actions.appendChild(allow);
    }
    var deny = el('button', 'pill pill--quiet', 'Deny');
    deny.type = 'button';
    deny.setAttribute('aria-label', 'Deny ' + entry.label);
    if (allow !== null) allow.addEventListener('click', function () { answer(entry, 'approve', allow, deny); });
    deny.addEventListener('click', function () { answer(entry, 'deny', allow, deny); });
    actions.appendChild(deny);
    item.appendChild(actions);
    return item;
  }

  function renderWaiting() {
    // What is drawn depends on the code and on whether it is an agent's (an agent's strip has no Allow).
    var drawn = waiting.map(function (entry) { return entry.code + (isAgentSignIn(entry.identity) ? ':agent' : ''); }).join('|');
    // Drawn again only when the list changed, so a button is not rebuilt under a finger.
    if (drawn !== waitingDrawn) {
      waitingDrawn = drawn;
      waitingList.textContent = '';
      waiting.forEach(function (entry) { waitingList.appendChild(stripFor(entry)); });
    }
    waitingList.hidden = !stripsShown();
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
        renderLine();
      });
    });
  }

  // Allow or Deny: sent as the approval page sends it. A code that is finished (ran out, used) is taken off the page and Nexus's words shown.
  function answer(entry, route, allow, deny) {
    if (allow !== null) allow.disabled = true;
    deny.disabled = true;
    say(alertBox, '');
    call('POST', 'device/' + route, { code: entry.code }).then(function (reply) {
      if (reply && reply.ok) {
        waiting = waiting.filter(function (other) { return other !== entry; });
        notice = route === 'approve' ? entry.label + ' can use Nexus now.' : entry.label + ' was not given a token.';
        renderWaiting();
        renderLine();
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
        renderLine();
      } else {
        if (allow !== null) allow.disabled = false;
        deny.disabled = false;
      }
      say(alertBox, wordsOf(reply));
    });
  }

  // Every few seconds: the devices waiting, and, while an agent that was just added has not joined, who is connected.
  function askAgainNow() {
    loadWaiting();
    if (view === ADD && added !== null && !joined) loadIdentities();
  }

  function stopPolling() {
    if (polling !== null) clearInterval(polling);
    polling = null;
  }

  function startPolling() {
    if (polling === null) polling = setInterval(askAgainNow, ASK_AGAIN_MS);
  }

  // ── adding an agent ────────────────────────────────────────────────────────

  // The one command to run on the agent: it joins the agent to Nexus and keeps what it prints in <name>.env.
  function commandFor(name) {
    return JOIN_COMMAND + ' ' + name + ' > ' + name + ENV_FILE_END;
  }

  // The form as it first opens: empty, with Add dim and no fault.
  function openAddForm() {
    nameField.value = '';
    takenWords = null;
    say(addAlert, '');
    added = null;
    joined = false;
    openView(ADD);
  }

  // The drawn words (board 27a) for a name that is already an agent; for any other name Nexus refuses, Nexus's own.
  function takenIn(typed, reply) {
    var isAgent = identities.some(function (person) { return person.name === typed && person.kind === AGENT; });
    return isAgent ? "There's already an agent called " + typed + '.' : wordsOf(reply);
  }

  // Letters that are not allowed are not let in, and typing anything clears a refused name at once.
  nameField.addEventListener('input', function () {
    var cleaned = nameField.value.replace(NAME_BLOCKED, '');
    if (cleaned !== nameField.value) nameField.value = cleaned;
    takenWords = null;
    say(addAlert, '');
    renderName();
  });

  addForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var typed = nameField.value.trim();
    if (adding || takenWords !== null || !NAME_OK.test(typed)) return;
    adding = true;
    say(addAlert, '');
    renderName();
    call('POST', 'identity', { name: typed, kind: AGENT }).then(function (reply) {
      adding = false;
      if (reply && reply.ok && reply.body && typeof reply.body.name === 'string') {
        nameField.value = '';
        added = { name: reply.body.name };
        joined = false;
        commandText.textContent = commandFor(reply.body.name);
        copyButton.textContent = 'Copy';
        notice = null;
        renderAll();
        loadIdentities();
        return;
      }
      if (reply && notSignedIn(reply)) {
        askAgain(reply);
        return;
      }
      if (reply && reply.status === 409) takenWords = takenIn(typed, reply);
      else say(addAlert, wordsOf(reply));
      renderName();
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

  // ── the bar, the tabs and Settings ─────────────────────────────────────────

  backButton.addEventListener('click', function () { openView(CONNECTED); });
  addOpen.addEventListener('click', openAddForm);
  addFirst.addEventListener('click', openAddForm);
  tabConnected.addEventListener('click', function () { openView(CONNECTED); });
  tabSettings.addEventListener('click', function () { openView(SETTINGS); });
  // The agent is taken off the page at once, so the agent view finds it gone and the page is back on the list with the Undo bar.
  removeAgentButton.addEventListener('click', function () {
    var person = personNamed(openAgent);
    if (person !== null) removeAgent(person);
  });

  // Sign out lets go of the owner secret this page holds and asks for it again. A browser that holds the owner's cookie is known again
  // the next time the page is opened: Nexus has no route that takes the cookie away.
  signOutButton.addEventListener('click', function () {
    ownerSecret = null;
    showOwner(null);
  });

  // ── start ──────────────────────────────────────────────────────────────────

  // Asks who is connected, and shows the page for the owner, the field for the owner secret when Nexus does not know who is asking, or
  // Nexus's own words.
  function load() {
    notice = CHECKING;
    renderLine();
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
      notice = wordsOf(reply);
      renderLine();
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
