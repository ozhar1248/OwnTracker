// Chrome supplies this event only when installation is available.
// Installing the shell does not change where data is stored or enable offline writes.
const banner = document.querySelector('#install-banner');
const button = document.querySelector('#install-app');
const message = document.querySelector('#install-message');
const standalone = window.matchMedia('(display-mode: standalone)');
let installPrompt = null;

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  if (standalone.matches) return;
  installPrompt = event;
  banner.hidden = false;
  button.disabled = false;
});

button.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  button.disabled = true;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    banner.hidden = true;
    if (outcome === 'accepted') showMessage('בקשת ההתקנה התקבלה. אפשר לחפש את OwnTracker במסך הבית או ברשימת האפליקציות.');
  } catch {
    banner.hidden = true;
    showMessage('אפשר לנסות להתקין דרך תפריט הדפדפן: התקנה או הוספה למסך הבית.');
  }
});

function markInstalled() {
  installPrompt = null;
  banner.hidden = true;
  message.hidden = true;
}
window.addEventListener('appinstalled', markInstalled);
standalone.addEventListener('change', event => { if (event.matches) markInstalled(); });
