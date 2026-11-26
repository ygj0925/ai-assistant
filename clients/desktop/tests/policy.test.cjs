const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseWebOrigin, allowsNavigation, allowsDownload, allowsResource, externalDestination, allowsClipboardWrite,
} = require('../src/policy.cjs');

const origin = 'http://127.0.0.1:3136';

test('accepts HTTPS and designated loopback HTTP origins', () => {
  for (const value of [origin, 'http://[::1]:3120', 'http://localhost:3200', 'https://assistant.example.com']) {
    assert.equal(parseWebOrigin(value), value);
  }
  for (const value of [
    'http://assistant.example.com', 'http://127.0.0.2', 'https://assistant.example.com/path',
    'https://assistant.example.com?q=1', 'https://assistant.example.com#anchor',
    'https://user:pass@assistant.example.com', ' https://assistant.example.com', 'file:///etc',
  ]) assert.throws(() => parseWebOrigin(value), TypeError, value);
});

test('isolates renderer requests by exact origin and resource type', () => {
  assert.equal(allowsNavigation(origin + '/chat?q=x#abc', origin), true);
  assert.equal(allowsNavigation(origin.replace('127.0.0.1', 'localhost'), origin), false);
  assert.equal(allowsNavigation('http://127.0.0.1:3137', origin), false);
  assert.equal(allowsNavigation('blob:' + origin + '/abcd', origin), false);
  assert.equal(allowsDownload('blob:' + origin + '/abcd', origin), true);
  assert.equal(allowsDownload('blob:https://example.com/abcd', origin), false);

  const request = (url, resourceType) => allowsResource({ url, resourceType }, origin);
  assert.equal(request(origin + '/_next/style.css', 'stylesheet'), true);
  assert.equal(request(origin + '/frame', 'subFrame'), false);
  assert.equal(request('https://example.com/track', 'xhr'), false);
  assert.equal(request('ws://127.0.0.1:3136/_next/webpack-hmr', 'webSocket'), true);
  assert.equal(request('ws://127.0.0.1:3137/_next/webpack-hmr', 'webSocket'), false);
  assert.equal(request('file:///C:/Windows/win.ini', 'other'), false);
  assert.equal(request('data:text/html,hello', 'subFrame'), false);
});

test('limits external candidates to canonical HTTPS domains', () => {
  assert.equal(externalDestination('https://example.com/guide?q=help'), 'https://example.com/guide?q=help');
  for (const value of [
    'https://localhost/path', 'https://local.internal/path', 'https://home.local/path',
    'https://device.home.arpa/path', 'https://127.0.0.1', 'https://[::1]',
    'http://example.com/', 'https://example.com:8040/', 'https://user@example.com/',
    'file:///example', 'mailto:someone@example.com', 'javascript:alert(1)', 'custom:open',
    'https://example.com/\nweird', 'https://example.com/' + 'x'.repeat(2048),
  ]) assert.equal(externalDestination(value), null, value);
});

test('limits sanitized clipboard writes to the focused trusted main frame', () => {
  const request = { permission: 'clipboard-sanitized-write', url: origin + '/chat', mainFrame: true, focused: true };
  assert.equal(allowsClipboardWrite(request, origin), true);
  for (const restriction of [
    { permission: 'clipboard-read' }, { permission: 'geolocation' }, { mainFrame: false }, { focused: false },
    { url: 'https://example.com/' }, { url: 'blob:' + origin + '/random' },
  ]) assert.equal(allowsClipboardWrite({ ...request, ...restriction }, origin), false);
});
