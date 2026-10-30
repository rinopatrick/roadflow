// Start screen + tutorial banner. Owns all start-screen DOM listeners.
import { toast } from './ui.js';
import { sfx } from './audio.js';

export function showStartScreen(visible) {
  document.getElementById('help').classList.toggle('open', visible);
}

export function initStartScreen(ctx) {
  document.getElementById('btnTutorial')?.addEventListener('click', () => {
    ctx.setTutorialMode(true);
    showStartScreen(false);
    ctx.updateTutorial();
    sfx.click();
  });
  document.getElementById('btnSandbox')?.addEventListener('click', () => {
    ctx.setTutorialMode(false);
    showStartScreen(false);
    sfx.click();
  });
  document.getElementById('btnContinue')?.addEventListener('click', () => {
    showStartScreen(false);
    if (ctx.loadFromSave()) toast('City loaded.');
    else ctx.newGame();
    sfx.click();
  });
  document.getElementById('btnSkipTutorial')?.addEventListener('click', () => {
    ctx.setTutorialMode(false);
    document.getElementById('tutorialBanner').hidden = true;
    sfx.click();
  });
}
