// Menu handlers + toolbar/dock button bindings. Owns every menu/toolbar DOM
// listener so main.js keeps world logic only. All world access via ctx.
import { closeInspect } from './ui.js';
import { saveGame, loadGame, hasRecoverableBackup, recoverFromBackup, exportGame, exportFilename, importGame } from './save.js';
import { toast } from './ui.js';
import { sfx } from './audio.js';

export function menuHandlers(ctx) {
  return {
    onSpeed: ctx.setSpeed,
    isSoundEnabled: ctx.isSoundEnabled,
    onSound: (enabled) => {
      ctx.applyAudio(enabled);
      if (enabled) sfx.click();
    },
    onSave: () => {
      const res = saveGame(ctx.getWorld());
      if (res.ok) ctx.clearDirty();
      toast(res.ok ? 'City saved.' : `Save failed — ${res.error}`, res.ok ? '' : 'warn');
      sfx.click();
    },
    onExport: () => {
      try {
        const text = exportGame(ctx.getWorld());
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFilename();
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        toast('City exported.');
      } catch (err) {
        toast(`Export failed — ${err.message}`, 'warn');
      }
      sfx.click();
    },
    onImport: (text, filename) => {
      if (!text) { toast(`Could not read ${filename}.`, 'warn'); return; }
      const result = importGame(text, {});
      if (!result.ok) {
        toast(`Import failed — ${result.error}. The current city is unchanged.`, 'warn');
        return;
      }
      ctx.replaceWorld(result.world);
      toast(`Imported ${filename}.`);
      sfx.click();
    },
    onLoad: () => {
      const probe = loadGame({ hooks: {} });
      if (!probe.ok && probe.empty) { toast('No save found.', 'warn'); return; }
      if (!probe.ok) {
        const hint = hasRecoverableBackup() ? ' Try Recover.' : '';
        toast(`${probe.error}.${hint}`, 'warn');
        return;
      }
      if (ctx.loadFromSave()) toast('City loaded.');
      sfx.click();
    },
    onRecover: () => {
      if (!hasRecoverableBackup()) { toast('No backup is available to recover.', 'warn'); return; }
      if (ctx.loadFromSave({ source: 'backup' })) toast('Recovered the previous save.');
      sfx.click();
    },
    onNewMap: () => {
      if (ctx.isDirty() && !confirm('Start a new map? Unsaved progress is lost.')) return;
      ctx.newGame();
      ctx.clearHistory();
      ctx.updateHistoryButtons();
      toast('New map generated.');
    },
  };
}

export function bindToolbarButtons(ctx) {
  document.getElementById('inspectClose').addEventListener('click', closeInspect);
  document.getElementById('fitbtn').addEventListener('click', () => {
    ctx.fitCity();
    sfx.click();
  });
  document.getElementById('undobtn').addEventListener('click', () => { ctx.undo(); sfx.click(); });
  document.getElementById('redobtn').addEventListener('click', () => { ctx.redo(); sfx.click(); });
}
