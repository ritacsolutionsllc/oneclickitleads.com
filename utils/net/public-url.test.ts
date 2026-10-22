import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNonPublicAddress, publicHttpUrl, resolvePublicUrl } from './public-url.ts';

test('blocks loopback, private, link-local, and metadata addresses', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ];
  for (const address of blocked) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  assert.equal(isNonPublicAddress('8.8.8.8'), false);
  assert.equal(isNonPublicAddress('1.1.1.1'), false);
  assert.equal(isNonPublicAddress('2606:4700:4700::1111'), false);
});

test('publicHttpUrl allows only public http(s) hosts', () => {
  assert.equal(publicHttpUrl('https://example.com/contact')?.hostname, 'example.com');
  assert.equal(publicHttpUrl('http://8.8.8.8/path')?.hostname, '8.8.8.8');
  for (const raw of [
    'ftp://example.com',
    'http://user:pass@example.com',
    'http://127.0.0.1',
    'http://[::1]/',
    'http://localhost/admin',
    'http://app.local',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.169.254/',
    'http://10.0.0.5',
    'file:///etc/passwd',
    'http://2130706433',
  ]) {
    assert.equal(publicHttpUrl(raw), null, raw);
  }
});

test('resolvePublicUrl rejects a hostname that resolves to a private address', async () => {
  const blocked = await resolvePublicUrl('https://example.com/contact', async () => ['10.0.0.5']);
  assert.equal(blocked, null);
  const allowed = await resolvePublicUrl('https://example.com/contact', async () => ['1.2.3.4']);
  assert.equal(allowed?.hostname, 'example.com');
  const mixed = await resolvePublicUrl('https://example.com/contact', async () => ['1.2.3.4', '127.0.0.1']);
  assert.equal(mixed, null);
  const failed = await resolvePublicUrl('https://example.com', async () => {
    throw new Error('dns');
  });
  assert.equal(failed, null);
});
