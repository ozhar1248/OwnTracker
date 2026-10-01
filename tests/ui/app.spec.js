import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createApp } from '../../server.js';

const test = base.extend({
  appUrl: async ({}, use) => {
    const server = createApp({ dbPath: ':memory:', today: () => '2026-10-01', clientConfig: { mode: 'local' } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
});

test('PWA manifest is accepted by Chromium and installation UI follows browser events', async ({ page, appUrl, context }) => {
  await page.goto(appUrl);
  await expect(page.locator('#app-content')).toBeVisible();
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  expect(JSON.parse(manifest.data).display).toBe('standalone');
  // This checks the UI handshake; it does not simulate or claim a real Android installation.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => {};
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: 'התקנת האפליקציה', exact: true }).click();
  await expect(page.locator('#install-message')).toContainText('בקשת ההתקנה התקבלה');
  await expect(page.locator('#install-banner')).not.toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('#install-message')).not.toBeVisible();
});

test('complete personal tracking workflow, duplicate prompt, report, archive and persistence on reload', async ({ page, appUrl, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(appUrl);
  await expect(page.getByRole('heading', { name: 'השינוי הראשון שלך מתחיל כאן' })).toBeVisible();
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-empty.png', fullPage: false });
  await page.getByRole('button', { name: 'שינוי חדש', exact: true }).click();
  await page.getByLabel('כותרת השינוי').fill('לא לאכול 3 שעות לפני השינה');
  await page.getByLabel('תיאור מפורט').fill('לסיים את ארוחת הערב עד 20:00');
  await page.getByRole('button', { name: 'שמירת השינוי', exact: true }).click();
  await expect(page.locator('#change-dialog')).not.toBeVisible();
  const title = 'לא לאכול 3 שעות לפני השינה';
  await page.getByRole('button', { name: `${title}, 2026-10-01: חסר מילוי`, exact: true }).click();
  await page.getByLabel('לא בוצע', { exact: true }).check();
  await page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true }).fill('ארוחת ערב משפחתית מאוחרת');
  await page.getByRole('button', { name: 'שמירת הדיווח', exact: true }).click();
  await expect(page.getByRole('button', { name: `${title}, 2026-10-01: לא בוצע, יש הסבר`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `${title}, 2026-10-01: לא בוצע, יש הסבר`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'כבר מילאת דיווח ליום הזה' })).toBeVisible();
  await page.getByRole('button', { name: 'מעבר לעריכת הדיווח' }).click();
  await expect(page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true })).toHaveValue('ארוחת ערב משפחתית מאוחרת');
  await page.getByLabel('בוצע', { exact: true }).check();
  await page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true }).fill('בדקתי שוב: סיימתי בזמן');
  await page.getByRole('button', { name: 'שמירת העדכון', exact: true }).click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();

  // Backfill through the UI, including an earlier date than the change creation.
  await page.getByRole('button', { name: 'מילוי הדיווח שלי' }).click();
  await page.getByRole('button', { name: 'מעבר לעריכת הדיווח' }).click();
  await page.getByLabel('תאריך הדיווח').fill('2026-09-29');
  await page.getByLabel('תאריך הדיווח').press('Tab');
  await page.getByLabel('אחר', { exact: true }).check();
  await page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true }).fill('יום עם סדר יום שונה');
  await page.getByRole('button', { name: 'שמירת הדיווח', exact: true }).click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: `${title}, 2026-09-29: אחר, יש הסבר`, exact: true })).toBeVisible();

  await page.getByRole('button', { name: `עריכת ${title}`, exact: true }).click();
  await page.getByLabel('כותרת השינוי').fill('ארוחת ערב מוקדמת');
  await page.getByLabel('תדירות', { exact: true }).selectOption('weekly');
  await page.getByRole('button', { name: 'שמירת השינוי', exact: true }).click();
  await expect(page.getByRole('button', { name: 'עריכת ארוחת ערב מוקדמת', exact: true })).toBeVisible();

  // Additional fixture data is isolated in this test's in-memory database.
  const second = await (await page.request.post(`${appUrl}/api/changes`, { data: { title: 'לצאת להליכה של 20 דקות', frequency: 'daily' } })).json();
  const third = await (await page.request.post(`${appUrl}/api/changes`, { data: { title: 'לקרוא 10 עמודים בספר', frequency: 'monthly' } })).json();
  for (const [id, status] of [[second.id, 'done'], [third.id, 'missed']]) {
    await page.request.post(`${appUrl}/api/changes/${id}/entries`, { data: { date: '2026-09-27', status, explanation: 'דיווח לדוגמה לצורך בדיקה בלבד' } });
    await page.request.post(`${appUrl}/api/changes/${id}/entries`, { data: { date: '2026-09-29', status: 'done' } });
    await page.request.post(`${appUrl}/api/changes/${id}/entries`, { data: { date: '2026-10-01', status: 'other', explanation: 'לנסות שוב מחר' } });
  }
  await page.reload();
  await expect(page.locator('#tracker-table tbody tr')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/desktop-tracker.png', fullPage: false });
  await page.locator('#tracker-periods').getByRole('button', { name: 'חודשי', exact: true }).click();
  await expect(page.locator('#tracker-table thead th')).toHaveCount(32);
  await page.locator('#tracker-periods').getByRole('button', { name: 'יומי', exact: true }).click();
  await expect(page.locator('#tracker-table thead th')).toHaveCount(2);
  await page.locator('#tracker-periods').getByRole('button', { name: 'שבועי', exact: true }).click();

  await page.getByRole('button', { name: 'הפקת דוח', exact: true }).click();
  const report = page.getByLabel('תוכן הדוח');
  await expect(report).toBeVisible();
  await expect(report).toHaveValue(/יום עם סדר יום שונה/);
  await expect(report).toHaveValue(/2026-09-30: חסר מילוי/);
  await expect(report).toHaveValue(/תדירות: שבועי/);
  await page.screenshot({ path: 'artifacts/desktop-report.png', fullPage: false });
  await page.getByRole('button', { name: 'העתקת דוח', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('הדוח הועתק');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'הורדת קובץ', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('OwnTracker-weekly-2026-10-01.txt');
  await page.getByLabel('סוג הדוח', { exact: true }).selectOption('monthly');
  await expect(report).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'העתקת דוח', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'הפקת דוח', exact: true }).click();
  await expect(report).toHaveValue(/סוג הדוח: חודשי/);

  await page.getByRole('link', { name: 'המעקב שלי', exact: true }).click();
  await page.getByRole('button', { name: 'עריכת ארוחת ערב מוקדמת', exact: true }).click();
  await page.getByRole('button', { name: 'מחיקת שינוי', exact: true }).click();
  await page.getByRole('button', { name: 'מחיקת השינוי', exact: true }).click();
  await expect(page.locator('#change-dialog')).not.toBeVisible();
  await expect(page.locator('#tracker-table')).toContainText('שבועי · נמחק');
  await page.getByRole('link', { name: 'השינויים שלי' }).click();
  await expect(page.locator('#changes-list')).not.toContainText('ארוחת ערב מוקדמת');
  await page.getByRole('button', { name: 'נמחקו', exact: true }).click();
  await expect(page.locator('#changes-list')).toContainText('ארוחת ערב מוקדמת');
  await page.getByRole('link', { name: 'דוחות ותובנות', exact: true }).click();
  await page.getByRole('button', { name: 'הפקת דוח', exact: true }).click();
  await expect(report).toHaveValue(/נמחק בתאריך 2026-10-01/);
  expect(errors).toEqual([]);
});

test('phone layout, safe rendering, keyboard focus and date collision when changing the selected date', async ({ page, appUrl }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = '<img src=x onerror=alert(1)> הליכה';
  const change = await (await page.request.post(`${appUrl}/api/changes`, { data: { title, frequency: 'daily' } })).json();
  await page.request.post(`${appUrl}/api/changes/${change.id}/entries`, { data: { date: '2026-09-30', status: 'done', explanation: 'טקסט שמור' } });
  await page.goto(appUrl);
  await expect(page.locator('#tracker-table')).toContainText(title);
  await expect(page.locator('#tracker-table img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'מילוי הדיווח שלי' }).click();
  await expect(page.locator('#entry-dialog')).toBeVisible();
  await page.getByLabel('תאריך הדיווח').fill('2026-09-30');
  await page.getByLabel('תאריך הדיווח').press('Tab');
  await expect(page.getByRole('heading', { name: 'כבר מילאת דיווח ליום הזה' })).toBeVisible();
  await page.getByRole('button', { name: 'מעבר לעריכת הדיווח' }).click();
  await expect(page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true })).toHaveValue('טקסט שמור');
  await page.screenshot({ path: 'artifacts/mobile-entry.png', fullPage: false });
  await page.getByRole('textbox', { name: 'הסבר לא חובה', exact: true }).press('Escape');
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'דוחות ותובנות', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'דוחות ותובנות', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel('סוג הדוח').selectOption('daily');
  await page.getByRole('button', { name: 'הפקת דוח', exact: true }).click();
  await expect(page.getByLabel('תוכן הדוח')).toHaveValue(/סוג הדוח: יומי/);
  await page.getByRole('link', { name: 'המעקב שלי', exact: true }).click();
  await page.screenshot({ path: 'artifacts/mobile-tracker.png', fullPage: false });
});
