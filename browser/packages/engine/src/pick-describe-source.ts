// What page.pick() reports about an element the user picked: a CSS selector that matches only that
// element (checked with querySelectorAll), its role, accessible name, tag, a text snippet and its
// box. Page-side JavaScript kept in a string: it runs in the tab's isolated world and in unit tests.
// It defines one function, __pickDescribe(element) -> {selector, role, name, tag, text, rect}.

export const PICK_DESCRIBE_SOURCE = String.raw`
function __pickEscape(value) {
  var text = String(value), out = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i), char = text.charAt(i);
    if (code === 0) { out += '�'; continue; }
    if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) ||
        (i === 1 && code >= 48 && code <= 57 && text.charCodeAt(0) === 45)) { out += '\\' + code.toString(16) + ' '; continue; }
    if (i === 0 && text.length === 1 && code === 45) { out += '\\-'; continue; }
    if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) { out += char; continue; }
    out += '\\' + char;
  }
  return out;
}
function __pickQuote(value) {
  return '"' + String(value).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ') + '"';
}
// Ids and test ids a framework generated (":r3:", "ember123", long hex) change between loads.
function __pickStable(value) {
  if (!value || value.length > 80) return false;
  if (/^:|^[0-9]|[0-9a-f]{8,}|\d{4,}|^(ember|react|vue|ng|mui|radix|headlessui)[-_:]?\d/i.test(value)) return false;
  return !/\s/.test(value);
}
function __pickTag(element) {
  var name = element.localName || String(element.tagName || '').toLowerCase();
  return __pickEscape(name);
}
function __pickUnique(element, selector) {
  try {
    var found = (element.ownerDocument || document).querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch (error) { return false; }
}
function __pickCandidates(element) {
  var tag = __pickTag(element), out = [], id = element.getAttribute('id');
  if (__pickStable(id)) out.push('#' + __pickEscape(id), tag + '#' + __pickEscape(id));
  var attributes = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label'];
  for (var i = 0; i < attributes.length; i++) {
    var value = element.getAttribute(attributes[i]);
    if (!value || value.length > 120) continue;
    var part = '[' + attributes[i] + '=' + __pickQuote(value) + ']';
    if (attributes[i].indexOf('data-') === 0) out.push(part);
    out.push(tag + part);
  }
  var classes = String(element.getAttribute('class') || '').split(/\s+/).filter(__pickStable);
  for (var c = 0; c < classes.length && c < 6; c++) out.push(tag + '.' + __pickEscape(classes[c]));
  return out;
}
function __pickSegment(element) {
  var tag = __pickTag(element), parent = element.parentElement;
  if (!parent) return tag;
  var same = 0, index = 0;
  for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName !== element.localName) continue;
    same++;
    if (child === element) index = same;
  }
  return same > 1 ? tag + ':nth-of-type(' + index + ')' : tag;
}
// The shortest path up the tree that matches only this element, anchored at a stable id when one
// is on the way.
function __pickPath(element) {
  var parts = [__pickSegment(element)], current = element;
  while (current.parentElement) {
    var selector = parts.join(' > ');
    if (__pickUnique(element, selector)) return selector;
    current = current.parentElement;
    var id = current.getAttribute('id');
    if (__pickStable(id) && __pickUnique(current, '#' + __pickEscape(id))) {
      var anchored = '#' + __pickEscape(id) + ' > ' + selector;
      if (__pickUnique(element, anchored)) return anchored;
    }
    parts.unshift(__pickSegment(current));
  }
  return parts.join(' > ');
}
function __pickSelector(element) {
  var candidates = __pickCandidates(element);
  for (var i = 0; i < candidates.length; i++) if (__pickUnique(element, candidates[i])) return candidates[i];
  return __pickPath(element);
}
var __PICK_ROLES = {a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation',
  main: 'main', header: 'banner', footer: 'contentinfo', form: 'form', table: 'table', ul: 'list', ol: 'list',
  li: 'listitem', dialog: 'dialog', option: 'option', summary: 'button', article: 'article', aside: 'complementary'};
var __PICK_INPUT_ROLES = {button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
  radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox'};
function __pickRole(element) {
  var explicit = String(element.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (explicit) return explicit;
  var tag = element.localName;
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : null;
  if (tag === 'input') {
    var type = String(element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') return null;
    return __PICK_INPUT_ROLES[type] || 'textbox';
  }
  return __PICK_ROLES[tag] || null;
}
function __pickClean(text, max) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function __pickLabelled(element) {
  var doc = element.ownerDocument || document, ids = String(element.getAttribute('aria-labelledby') || '').split(/\s+/);
  var text = ids.map(function (id) { var node = id && doc.getElementById(id); return node ? node.textContent : ''; }).join(' ');
  if (__pickClean(text, 200)) return text;
  var id = element.getAttribute('id');
  var label = id ? doc.querySelector('label[for=' + __pickQuote(id) + ']') : null;
  label = label || (element.closest ? element.closest('label') : null);
  return label ? label.textContent : '';
}
function __pickName(element, role) {
  var name = __pickClean(element.getAttribute('aria-label'), 200) || __pickClean(__pickLabelled(element), 200);
  if (name) return name;
  var attributes = ['alt', 'title', 'placeholder'];
  for (var i = 0; i < attributes.length; i++) {
    var value = __pickClean(element.getAttribute(attributes[i]), 200);
    if (value) return value;
  }
  if (element.localName === 'input' && /^(button|submit|reset)$/i.test(element.getAttribute('type') || ''))
    return __pickClean(element.getAttribute('value'), 200) || null;
  var named = /^(button|link|heading|tab|menuitem|option|listitem|cell|checkbox|radio)$/.test(role || '');
  return named ? __pickClean(element.textContent, 200) || null : null;
}
function __pickRect(element) {
  var box = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  if (!box) return {x: 0, y: 0, width: 0, height: 0};
  return {x: Math.round(box.left || box.x || 0), y: Math.round(box.top || box.y || 0), width: Math.round(box.width || 0), height: Math.round(box.height || 0)};
}
function __pickDescribe(element) {
  var role = __pickRole(element);
  var text = element.localName === 'input' || element.localName === 'textarea' ? '' : __pickClean(element.innerText || element.textContent, 160);
  return {selector: __pickSelector(element), role: role, name: __pickName(element, role), tag: element.localName,
    text: text, rect: __pickRect(element)};
}
`;
