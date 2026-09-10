import type { ApiHandler } from './common';

/**
 * The interactive API reference at `GET /api/explorer` (docs/052) — Slopesmith's counterpart to naisys's
 * Scalar page, built the other way round. Naisys renders a generated OpenAPI spec; this server has no spec
 * and needs none, because every response already describes itself through the HATEOAS envelope. So the
 * reference is a generic hypermedia CLIENT: one self-contained page that starts at `/api`, renders
 * `_links` as navigation, `_actions` as forms pre-filled from their body stubs, templates with inputs for
 * their `{variables}`, and schemas on demand — and lets you send the request, exactly as an agent would.
 * It cannot drift from the API, because it renders what the API says rather than a copy of it.
 *
 * Self-contained on purpose: inline CSS and JS, no CDN, no build step, so it works on an air-gapped
 * deployment and adds no dependency. The page itself carries no data — every fetch it makes is gated by
 * the ordinary route access — which is why the mount is public, like the login page in front of the
 * editor: it is HOW a browser-holding human reaches the surface, including the sign-in.
 *
 * All fetched text lands in the DOM through `textContent`, never markup, so a stored name cannot script
 * this page. The page talks only to `/api/...` on its own origin, with the browser's own cookie; a bearer
 * key typed into it lives in a variable for the life of the tab and is never stored.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Slopesmith API explorer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #10151c; color: #d7dee8; font: 14px/1.5 system-ui, sans-serif; }
  header { display: flex; gap: 8px; align-items: center; padding: 10px 14px; background: #171f29;
           border-bottom: 1px solid #2a3644; position: sticky; top: 0; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0 10px 0 0; color: #8ecdf5; white-space: nowrap; }
  input, textarea, button, select {
    background: #0d1218; color: #d7dee8; border: 1px solid #33414f; border-radius: 6px;
    font: inherit; padding: 5px 8px; }
  textarea { width: 100%; min-height: 72px; font: 12px/1.45 ui-monospace, monospace; resize: vertical; }
  button { cursor: pointer; background: #223142; }
  button:hover { background: #2b3d52; }
  button.primary { background: #2b5d8f; border-color: #3d78b3; }
  button.primary:hover { background: #356fa8; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  #path { flex: 1 1 260px; min-width: 180px; font-family: ui-monospace, monospace; }
  #key { width: 210px; font-family: ui-monospace, monospace; }
  main { max-width: 1080px; margin: 0 auto; padding: 14px; }
  #status { color: #93a4b8; font-size: 12px; margin: 6px 2px 12px; min-height: 16px; }
  #status .err { color: #ff9d87; }
  section { margin-bottom: 16px; }
  section > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #7c8ea3;
                 margin: 0 0 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px;
          background: #1a2430; border: 1px solid #2c3b4c; border-radius: 8px; padding: 7px 11px;
          cursor: pointer; max-width: 330px; text-align: left; }
  .chip:hover { border-color: #4a83b8; background: #1e2b3a; }
  .chip .rel { color: #8ecdf5; font-weight: 600; }
  .chip .title { color: #8b9cb0; font-size: 12px; }
  .card { background: #161e28; border: 1px solid #2a3644; border-radius: 10px; padding: 10px 12px;
          margin-bottom: 10px; }
  .card.disabled { opacity: 0.62; }
  .card .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .method { font: 600 11px/1 ui-monospace, monospace; padding: 3px 6px; border-radius: 5px;
            background: #234; color: #9fd0ff; }
  .method.POST { background: #1d3a26; color: #93e0a9; }
  .method.PUT { background: #3a321d; color: #e0c893; }
  .method.DELETE { background: #3a1d1d; color: #e09393; }
  .href { font-family: ui-monospace, monospace; font-size: 12px; color: #b9c8d9; word-break: break-all; }
  .rel { font-weight: 600; color: #d7dee8; }
  .note { color: #8b9cb0; font-size: 12px; margin-top: 3px; }
  .reason { color: #e0a893; font-size: 12px; margin-top: 3px; }
  .vars { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .vars label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #93a4b8; }
  .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  pre { background: #0c1117; border: 1px solid #26313e; border-radius: 8px; padding: 10px 12px;
        overflow: auto; font: 12px/1.45 ui-monospace, monospace; max-height: 480px; white-space: pre-wrap;
        word-break: break-word; margin: 0; }
  img.preview { max-width: 100%; border-radius: 8px; border: 1px solid #26313e; background: #0c1117; }
  details { margin-top: 8px; }
  details > summary { cursor: pointer; color: #7c8ea3; font-size: 12px; }
  .schema-view { margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>Slopesmith API</h1>
  <button id="back" title="Back">&#8592;</button>
  <button id="home" title="Go to /api">/api</button>
  <input id="path" spellcheck="false" value="/api" autocomplete="off">
  <button id="go" class="primary">Go</button>
  <input id="key" type="password" placeholder="Bearer key (optional)" spellcheck="false"
         title="slop_… access key for a server with accounts. Kept in this tab only, never stored.">
</header>
<main>
  <div id="status">Loading /api…</div>
  <div id="view"></div>
</main>
<script>
'use strict';
var view = document.getElementById('view');
var statusLine = document.getElementById('status');
var pathBox = document.getElementById('path');
var keyBox = document.getElementById('key');
var history_ = [];
var current = null;
var ENVELOPE = { _links: 1, _actions: 1, _linkTemplates: 1, _actionTemplates: 1 };

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function apiPath(raw) {
  var path = String(raw || '').trim();
  if (!path.indexOf('http')) {
    try { path = new URL(path).pathname + new URL(path).search; } catch (e) { /* fall through */ }
  }
  if (path.charAt(0) !== '/') path = '/' + path;
  return path.indexOf('/api') === 0 ? path : null;
}

function request(method, path, options) {
  options = options || {};
  var headers = {};
  var key = keyBox.value.trim();
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  else if (options.contentType) headers['content-type'] = options.contentType;
  var body = options.json !== undefined ? options.json : options.bytes;
  var started = Date.now();
  return fetch(path, { method: method, headers: headers, body: body }).then(function (res) {
    var type = res.headers.get('content-type') || '';
    var read = type.indexOf('image/') === 0 || type.indexOf('audio/') === 0 || type.indexOf('video/') === 0
      ? res.blob() : res.text();
    return read.then(function (payload) {
      return { status: res.status, type: type, payload: payload, ms: Date.now() - started };
    });
  });
}

function setStatus(method, path, reply, error) {
  statusLine.textContent = '';
  var text = method + ' ' + path;
  if (reply) {
    text += ' \\u2192 ' + reply.status + ' \\u00b7 ' + reply.ms + ' ms';
    if (typeof reply.payload === 'string') text += ' \\u00b7 ' + reply.payload.length + ' chars';
  }
  statusLine.appendChild(el('span', reply && reply.status >= 400 ? 'err' : '', text));
  if (error) statusLine.appendChild(el('span', 'err', ' \\u2014 ' + error));
}

function navigate(path, options) {
  var target = apiPath(path);
  if (!target) { setStatus('GET', String(path), null, 'this page only browses /api paths on its own origin'); return; }
  if (current && (!options || !options.replace)) history_.push(current);
  current = target;
  pathBox.value = target;
  statusLine.textContent = 'GET ' + target + ' \\u2026';
  request('GET', target).then(function (reply) {
    setStatus('GET', target, reply);
    render(reply, target);
  }).catch(function (error) {
    setStatus('GET', target, null, String(error && error.message || error));
  });
}

function invoke(action, path, options) {
  statusLine.textContent = action.method + ' ' + path + ' \\u2026';
  request(action.method, path, options).then(function (reply) {
    setStatus(action.method, path, reply);
    render(reply, path);
  }).catch(function (error) {
    setStatus(action.method, path, null, String(error && error.message || error));
  });
}

function fillTemplate(template, inputs) {
  return template.replace(/\\{(\\w+)\\}/g, function (whole, name) {
    var box = inputs[name];
    return box ? encodeURIComponent(box.value) : whole;
  });
}

function templateInputs(template, host) {
  var names = [];
  template.replace(/\\{(\\w+)\\}/g, function (whole, name) {
    if (names.indexOf(name) < 0) names.push(name);
    return whole;
  });
  var inputs = {};
  if (!names.length) return inputs;
  var wrap = el('div', 'vars');
  names.forEach(function (name) {
    var label = el('label', '', name + ':');
    var box = el('input');
    box.spellcheck = false;
    label.appendChild(box);
    wrap.appendChild(label);
    inputs[name] = box;
  });
  host.appendChild(wrap);
  return inputs;
}

function schemaButton(card, schemaHref) {
  if (!schemaHref) return;
  var button = el('button', '', 'schema');
  button.addEventListener('click', function () {
    var shown = card.querySelector('.schema-view');
    if (shown) { shown.remove(); return; }
    request('GET', schemaHref).then(function (reply) {
      var pre = el('pre', 'schema-view');
      try { pre.textContent = JSON.stringify(JSON.parse(reply.payload), null, 2); }
      catch (e) { pre.textContent = String(reply.payload); }
      card.appendChild(pre);
    });
  });
  return button;
}

function actionCard(action, isTemplate) {
  var card = el('div', 'card' + (action.disabled ? ' disabled' : ''));
  var head = el('div', 'head');
  head.appendChild(el('span', 'method ' + action.method, action.method));
  head.appendChild(el('span', 'rel', action.rel));
  head.appendChild(el('span', 'href', isTemplate ? action.hrefTemplate : action.href));
  card.appendChild(head);
  if (action.title) card.appendChild(el('div', 'note', action.title));
  if (action.disabled) card.appendChild(el('div', 'reason', 'disabled: ' + (action.disabledReason || '')));

  var inputs = isTemplate ? templateInputs(action.hrefTemplate, card) : {};
  var row = el('div', 'row');
  var body = null;
  var file = null;
  if (action.alternateEncoding) {
    card.appendChild(el('div', 'note', action.alternateEncoding.description || ''));
    file = el('input');
    file.type = 'file';
    row.appendChild(file);
  } else if (action.method !== 'GET' && action.method !== 'DELETE') {
    body = el('textarea');
    body.value = action.body !== undefined ? JSON.stringify(action.body, null, 2) : '{}';
    body.spellcheck = false;
    card.appendChild(body);
  }
  var send = el('button', 'primary', 'Send');
  if (action.disabled) send.disabled = true;
  send.addEventListener('click', function () {
    var href = isTemplate ? fillTemplate(action.hrefTemplate, inputs) : action.href;
    var target = apiPath(href);
    if (!target) { setStatus(action.method, href, null, 'not an /api path'); return; }
    if (file) {
      var chosen = file.files && file.files[0];
      if (!chosen) { setStatus(action.method, target, null, 'choose a file first'); return; }
      chosen.arrayBuffer().then(function (bytes) {
        invoke(action, target, { bytes: bytes,
          contentType: action.alternateEncoding.contentType || 'application/octet-stream' });
      });
      return;
    }
    if (body) {
      try { JSON.parse(body.value); }
      catch (e) { setStatus(action.method, target, null, 'body is not valid JSON: ' + e.message); return; }
      invoke(action, target, { json: body.value });
      return;
    }
    invoke(action, target, {});
  });
  row.appendChild(send);
  var schema = schemaButton(card, action.schema);
  if (schema) row.appendChild(schema);
  card.appendChild(row);
  return card;
}

function linkTemplateCard(template) {
  var card = el('div', 'card');
  var head = el('div', 'head');
  head.appendChild(el('span', 'method', 'GET'));
  head.appendChild(el('span', 'rel', template.rel));
  head.appendChild(el('span', 'href', template.hrefTemplate));
  card.appendChild(head);
  if (template.title) card.appendChild(el('div', 'note', template.title));
  var inputs = templateInputs(template.hrefTemplate, card);
  var row = el('div', 'row');
  var open = el('button', 'primary', 'Open');
  open.textContent = template.execution === 'browser' ? 'Open in browser' : 'Open';
  open.addEventListener('click', function () {
    var href = fillTemplate(template.hrefTemplate, inputs);
    if (template.execution === 'browser') window.open(href, '_blank', 'noopener'); else navigate(href);
  });
  row.appendChild(open);
  card.appendChild(row);
  return card;
}

function renderSection(title, host, build) {
  var section = el('section');
  section.appendChild(el('h2', '', title));
  build(section);
  host.appendChild(section);
}

function render(reply, path) {
  view.textContent = '';
  if (typeof reply.payload !== 'string') {
    var url = URL.createObjectURL(reply.payload);
    if (reply.type.indexOf('image/') === 0) {
      var img = el('img', 'preview');
      img.src = url;
      view.appendChild(img);
    } else {
      var audio = document.createElement(reply.type.indexOf('audio/') === 0 ? 'audio' : 'video');
      audio.controls = true;
      audio.src = url;
      view.appendChild(audio);
    }
    return;
  }
  if (reply.type.indexOf('application/json') < 0) {
    var pre = el('pre', '', reply.payload.slice(0, 300000));
    view.appendChild(pre);
    return;
  }
  var data;
  try { data = JSON.parse(reply.payload); }
  catch (e) { view.appendChild(el('pre', '', reply.payload.slice(0, 300000))); return; }

  if (data && data.error) view.appendChild(el('div', 'reason', 'error: ' + data.error));

  if (data && Array.isArray(data._links) && data._links.length) {
    renderSection('Links', view, function (section) {
      var chips = el('div', 'chips');
      data._links.forEach(function (link) {
        var chip = el('button', 'chip');
        chip.appendChild(el('span', 'rel', link.rel));
        chip.appendChild(el('span', 'href', link.href));
        if (link.title) chip.appendChild(el('span', 'title', link.title));
        chip.addEventListener('click', function () {
          if (link.execution === 'browser') window.open(link.href, '_blank', 'noopener'); else navigate(link.href);
        });
        chips.appendChild(chip);
      });
      section.appendChild(chips);
    });
  }
  if (data && Array.isArray(data._actions) && data._actions.length) {
    renderSection('Actions', view, function (section) {
      data._actions.forEach(function (action) { section.appendChild(actionCard(action, false)); });
    });
  }
  if (data && Array.isArray(data._actionTemplates) && data._actionTemplates.length) {
    renderSection('Action templates', view, function (section) {
      data._actionTemplates.forEach(function (action) { section.appendChild(actionCard(action, true)); });
    });
  }
  if (data && Array.isArray(data._linkTemplates) && data._linkTemplates.length) {
    renderSection('Link templates', view, function (section) {
      data._linkTemplates.forEach(function (template) { section.appendChild(linkTemplateCard(template)); });
    });
  }

  var rest = {};
  var kept = 0;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.keys(data).forEach(function (name) {
      if (!ENVELOPE[name]) { rest[name] = data[name]; kept++; }
    });
  } else { rest = data; kept = 1; }
  if (kept) {
    renderSection('Response', view, function (section) {
      var text = JSON.stringify(rest, null, 2);
      var pre = el('pre');
      if (text.length > 300000) {
        pre.textContent = text.slice(0, 300000);
        section.appendChild(el('div', 'note',
          'showing the first 300,000 of ' + text.length + ' characters'));
      } else pre.textContent = text;
      section.appendChild(pre);
    });
  }
}

document.getElementById('go').addEventListener('click', function () { navigate(pathBox.value); });
pathBox.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') navigate(pathBox.value);
});
document.getElementById('home').addEventListener('click', function () { navigate('/api'); });
document.getElementById('back').addEventListener('click', function () {
  var previous = history_.pop();
  if (previous) { current = null; navigate(previous, { replace: true }); }
});
keyBox.addEventListener('change', function () { if (current) navigate(current, { replace: true }); });
navigate('/api', { replace: true });
</script>
</body>
</html>
`;

export const explorerRoutes: Record<string, ApiHandler> = {
  '/api/explorer': (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(PAGE);
  },
};
