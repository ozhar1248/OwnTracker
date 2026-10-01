import { createReport } from './domain.js';

// Supabase's HTTPS Auth and PostgREST APIs; no service/secret keys or added packages.
export function createCloudClient(config, environment = {}) {
  const requestFetch = environment.fetch || globalThis.fetch.bind(globalThis);
  const storage = environment.storage || globalThis.localStorage;
  const locks = environment.locks || globalThis.navigator?.locks;
  const events = environment.events || globalThis.window;
  const base = new URL(config.supabaseUrl).origin;
  if (!base.startsWith('https://') || !config.publishableKey?.startsWith('sb_publishable_')) throw new Error('הגדרות החיבור לענן אינן תקינות.');
  const key = `owntracker-session:${base}`;
  const listeners = new Set();
  let refreshing = null;
  let epoch = 0;
  let memorySession = null;

  function readSession() {
    try {
      const data = JSON.parse(storage.getItem(key) || 'null');
      return data?.access_token && data?.refresh_token ? data : null;
    } catch { return memorySession; }
  }
  function saveSession(session) {
    memorySession = session;
    try { if (session) storage.setItem(key, JSON.stringify(session)); else storage.removeItem(key); }
    catch { /* Private browsing may disable persistent storage. The current tab still works. */ }
    for (const listener of listeners) listener(session?.user || null);
  }
  function error(message, status = 400, entry) { return Object.assign(new Error(message), { status, entry }); }
  function normalizedSession(data) {
    if (!data.access_token || !data.refresh_token || !data.user?.id) throw error('תשובת ההתחברות אינה תקינה. נסו שוב.');
    return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600), user: { id: data.user.id, email: data.user.email } };
  }
  async function http(path, { method = 'GET', body, token } = {}) {
    let response;
    try {
      response = await requestFetch(`${base}${path}`, {
        method, headers: { apikey: config.publishableKey, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch { throw error('אין חיבור לשירות הענן. בדקו את החיבור ונסו שוב. לא התקבל אישור שמירה.', 0); }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const code = data?.error_code || data?.code;
      let message = 'לא ניתן להשלים את הפעולה בענן. נסו שוב.';
      if (code === 'invalid_credentials') message = 'כתובת האימייל או הסיסמה אינן נכונות.';
      else if (code === 'email_not_confirmed') message = 'יש לאמת את כתובת האימייל לפני ההתחברות.';
      else if (code === 'PGRST202' || code === 'PGRST205') message = 'הקמת בסיס הנתונים טרם הושלמה. יש להריץ את קובץ setup.sql בפרויקט Supabase.';
      else if (response.status === 429) message = 'בוצעו יותר מדי ניסיונות. המתינו מעט ונסו שוב.';
      else if (response.status === 401 || response.status === 403) message = 'החיבור לחשבון פג או שאין הרשאה. יש להתחבר מחדש.';
      throw Object.assign(error(message, response.status), { code });
    }
    return data;
  }

  async function freshSession(force = false, rejectedToken = '') {
    if (refreshing) return refreshing;
    const refresh = async () => {
      const startEpoch = epoch;
      const current = readSession();
      if (!current) throw error('יש להתחבר לחשבון.', 401);
      // A different tab may already have refreshed while this tab was waiting for the lock.
      if ((!force || (rejectedToken && current.access_token !== rejectedToken)) && current.expires_at > Date.now() / 1000 + 60) return current;
      let data;
      try { data = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: current.refresh_token } }); }
      catch (cause) {
        if ([400, 401, 403].includes(cause.status) && startEpoch === epoch && readSession()?.refresh_token === current.refresh_token) { epoch++; saveSession(null); }
        throw cause;
      }
      // Never resurrect a session after sign-out or a change of account.
      if (startEpoch !== epoch || readSession()?.refresh_token !== current.refresh_token) throw error('החשבון השתנה. יש לטעון מחדש.', 401);
      const session = normalizedSession(data);
      saveSession(session);
      return session;
    };
    refreshing = locks?.request ? locks.request(`${key}:refresh`, refresh) : refresh();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function authorized(path, options = {}) {
    const startEpoch = epoch;
    const session = await freshSession();
    let data;
    try { data = await http(path, { ...options, token: session.access_token }); }
    catch (cause) {
      if (cause.status !== 401 || epoch !== startEpoch) throw cause;
      const refreshed = await freshSession(true, session.access_token);
      data = await http(path, { ...options, token: refreshed.access_token });
    }
    if (epoch !== startEpoch || readSession()?.user?.id !== session.user.id) throw error('החשבון השתנה. יש להתחבר מחדש.', 401);
    return data;
  }

  async function rpc(action, payload = {}) {
    const result = await authorized('/rest/v1/rpc/owntracker_api', { method: 'POST', body: { action, payload } });
    if (result?.error) throw error(result.error, result.status, result.entry);
    return result;
  }

  events?.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    const next = readSession();
    if (next?.user?.id !== memorySession?.user?.id) epoch++;
    memorySession = next;
    for (const listener of listeners) listener(next?.user || null);
  });
  return {
    get user() { return readSession()?.user || null; },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    async initialize() {
      memorySession = readSession();
      if (!memorySession) return null;
      try {
        const user = await authorized('/auth/v1/user');
        if (user.id !== readSession()?.user?.id) { epoch++; saveSession(null); return null; }
        return user;
      } catch (cause) {
        if ([400, 401, 403].includes(cause.status)) { epoch++; saveSession(null); return null; }
        throw cause;
      }
    },
    async signIn(email, password) {
      const startEpoch = ++epoch;
      const data = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
      if (epoch !== startEpoch) throw error('ההתחברות בוטלה. נסו שוב.');
      const session = normalizedSession(data);
      saveSession(session);
      return session.user;
    },
    async signOut() {
      const current = readSession();
      epoch++;
      saveSession(null);
      // Local sign-out is immediate, even offline. Other devices retain their own sessions.
      if (current) await http('/auth/v1/logout?scope=local', { method: 'POST', token: current.access_token }).catch(() => {});
    },
    async request(path, { method = 'GET', body = {} } = {}) {
      const url = new URL(path, 'https://owntracker.invalid');
      if (url.pathname === '/api/state' && method === 'GET') return rpc('state');
      if (url.pathname === '/api/backup' && method === 'GET') return { format: 'owntracker-v1', exported_at: new Date().toISOString(), ...await rpc('state') };
      if (url.pathname === '/api/report' && method === 'GET') return createReport(await rpc('state'), url.searchParams.get('date'), url.searchParams.get('period'));
      if (url.pathname === '/api/changes' && method === 'POST') return rpc('create_change', body);
      const change = url.pathname.match(/^\/api\/changes\/([1-9]\d*)$/);
      if (change && ['PUT', 'DELETE'].includes(method)) return rpc(method === 'PUT' ? 'update_change' : 'archive_change', { ...body, id: Number(change[1]) });
      const entry = url.pathname.match(/^\/api\/changes\/([1-9]\d*)\/entries$/);
      if (entry && ['POST', 'PUT'].includes(method)) return rpc(method === 'PUT' ? 'update_entry' : 'create_entry', { ...body, id: Number(entry[1]) });
      throw error('הפעולה אינה נתמכת.', 404);
    },
  };
}
