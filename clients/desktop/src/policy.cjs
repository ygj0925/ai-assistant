const { isIP } = require('node:net');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const RESERVED_SUFFIXES = new Set(['arpa', 'example', 'internal', 'invalid', 'local', 'localhost', 'onion', 'test']);

function parseUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function parseWebOrigin(value) {
  const url = parseUrl(value);
  const secure = url && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)));
  if (!secure || url.href !== url.origin + '/') {
    throw new TypeError('助手服务地址需为 HTTPS 源地址，或本机 HTTP 回环源地址。');
  }
  return url.origin;
}

function allowsNavigation(value, trustedOrigin) {
  const url = parseUrl(value);
  return Boolean(url && (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === trustedOrigin);
}

function allowsDownload(value, trustedOrigin) {
  const url = parseUrl(value);
  return allowsNavigation(value, trustedOrigin) ||
    Boolean(url && url.protocol === 'blob:' && url.origin === trustedOrigin);
}

function allowsResource({ url: value, resourceType }, trustedOrigin) {
  if (resourceType === 'subFrame') return false;
  if (resourceType === 'mainFrame') return allowsNavigation(value, trustedOrigin);
  if (allowsDownload(value, trustedOrigin)) return true;
  const url = parseUrl(value);
  if (!url || resourceType !== 'webSocket') return false;
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else return false;
  return url.origin === trustedOrigin;
}

function externalDestination(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || url.port || url.href.length > 2048) return null;
  const hostname = url.hostname.replace(/\.$/, '');
  const dns = hostname.split('.');
  const last = dns.at(-1);
  if (dns.length < 2 || isIP(hostname.replace(/^\[|\]$/g, '')) ||
      RESERVED_SUFFIXES.has(last) ||
      dns.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return null;
  }
  return url.href;
}

function allowsClipboardWrite({ permission, url, mainFrame, focused }, trustedOrigin) {
  return permission === 'clipboard-sanitized-write' && mainFrame && focused &&
    allowsNavigation(url, trustedOrigin);
}

module.exports = {
  parseWebOrigin, allowsNavigation, allowsDownload, allowsResource, externalDestination, allowsClipboardWrite,
};
