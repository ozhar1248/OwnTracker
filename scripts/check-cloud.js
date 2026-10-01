import { config } from '../public/config.js';

// Only read public configuration and query an empty row range. No accounts or data are created.
const headers = { apikey: config.publishableKey };
const auth = await fetch(`${config.supabaseUrl}/auth/v1/settings`, { headers });
console.log(`Supabase Auth connection: HTTP ${auth.status}`);
if (!auth.ok) { console.log('Check the project URL and publishable key.'); process.exitCode = 1; }
else {
  const data = await auth.json();
  console.log(`Email login enabled: ${Boolean(data.external?.email)}`);
  const schema = await fetch(`${config.supabaseUrl}/rest/v1/owntracker_changes?select=id&limit=0`, { headers });
  const detail = await schema.json().catch(() => ({}));
  console.log(`Schema probe: HTTP ${schema.status}${detail.code ? ` (${detail.code})` : ''}`);
  console.log(schema.status === 404 ? 'Run supabase/setup.sql in the SQL Editor.' : 'Authenticated checks are required to validate cloud access and user isolation.');
}
