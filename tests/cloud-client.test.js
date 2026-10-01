import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../public/cloud-client.js';

const config = { supabaseUrl: 'https://test.supabase.co', publishableKey: 'sb_publishable_test' };
function fixture(handler) {
  const values = new Map();
  const calls = [];
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const client = createCloudClient(config, { storage, events: new EventTarget(), locks: { request: (_key, callback) => callback() }, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    return handler(url, options, body);
  } });
  return { client, calls, values };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const session = (suffix = 'one', expires_at = Math.floor(Date.now() / 1000) + 3600) => ({ access_token: `token-${suffix}`, refresh_token: `refresh-${suffix}`, expires_at, user: { id: 'user-one', email: 'test@example.invalid' } });

test('cloud requires sign-in, uses only the public API key and sends user access token on RPC', async () => {
  const { client, calls, values } = fixture((url, options, body) => {
    if (url.includes('grant_type=password')) return response(session());
    assert.equal(options.headers.Authorization, 'Bearer token-one');
    assert.equal(body.action, 'create_change');
    assert.equal(body.payload.title, 'הליכה');
    return response({ id: 1, title: 'הליכה' });
  });
  await assert.rejects(client.request('/api/state'), cause => cause.status === 401);
  assert.equal(calls.length, 0);
  await client.signIn('test@example.invalid', 'not-a-real-password');
  const change = await client.request('/api/changes', { method: 'POST', body: { title: 'הליכה', frequency: 'daily' } });
  assert.equal(change.id, 1);
  assert.equal(calls[0].options.headers.apikey, 'sb_publishable_test');
  assert.equal([...values.values()][0].includes('not-a-real-password'), false);
});

test('cloud propagates duplicate/version conflicts including the saved entry', async () => {
  const { client } = fixture(url => url.includes('grant_type=password') ? response(session()) : response({ status: 409, error: 'already exists', entry: { id: 4, version: 2 } }));
  await client.signIn('test@example.invalid', 'password');
  await assert.rejects(client.request('/api/changes/1/entries', { method: 'POST', body: { date: '2026-10-01' } }), cause => cause.status === 409 && cause.entry.version === 2);
});

test('expired session refresh is shared by simultaneous reads and tokens rotate', async () => {
  const { client, calls } = fixture(async (url, options, body) => {
    if (url.includes('grant_type=password')) return response(session('old', 1));
    if (url.includes('grant_type=refresh_token')) { assert.equal(body.refresh_token, 'refresh-old'); return response(session('new')); }
    assert.equal(options.headers.Authorization, 'Bearer token-new');
    return response({ changes: [], entries: [], today: '2026-10-01' });
  });
  await client.signIn('test@example.invalid', 'password');
  await Promise.all([client.request('/api/state'), client.request('/api/state')]);
  assert.equal(calls.filter(call => call.url.includes('grant_type=refresh_token')).length, 1);
});

test('a response arriving after sign-out cannot display the previous account data', async () => {
  let finish;
  const { client } = fixture(url => {
    if (url.includes('grant_type=password')) return response(session());
    if (url.includes('/logout')) return response({});
    return new Promise(resolve => { finish = () => resolve(response({ private: 'old account data' })); });
  });
  await client.signIn('test@example.invalid', 'password');
  const pending = client.request('/api/state');
  await new Promise(resolve => setImmediate(resolve));
  await client.signOut();
  finish();
  await assert.rejects(pending, cause => cause.status === 401);
  assert.equal(client.user, null);
});

test('transient network failure never reports success or clears the saved session', async () => {
  const { client } = fixture(url => {
    if (url.includes('grant_type=password')) return response(session('expired', 1));
    throw new TypeError('network failure');
  });
  await client.signIn('test@example.invalid', 'password');
  await assert.rejects(client.request('/api/state'), cause => cause.status === 0);
  assert.equal(client.user.id, 'user-one');
});

test('cloud report and backup use a complete authenticated snapshot and shared timezone', async () => {
  const snapshot = { changes: [], entries: [], today: '2026-10-01', timezone: 'Asia/Jerusalem' };
  const { client } = fixture(url => url.includes('grant_type=password') ? response(session()) : response(snapshot));
  await client.signIn('test@example.invalid', 'password');
  const report = await client.request('/api/report?date=2026-10-01&period=weekly');
  assert.match(report, /Asia\/Jerusalem/);
  assert.match(report, /מספר שינויים בטווח: 0/);
  assert.equal((await client.request('/api/backup')).format, 'owntracker-v1');
});
