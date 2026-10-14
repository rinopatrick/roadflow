// The layer control: one labelled toggle per analytic overlay, plus its legend.
//
// DESIGN section 1: "Layer controls have labels and legend... One analytic
// overlay active at a time." The toggles are built from LAYERS, so a layer that
// has no simulated data source cannot appear here — the control and the data
// model cannot disagree.
//
// The legend is not decoration: it is what makes the overlay readable without
// relying on colour, because every band has a written label beside its swatch.
import { ui } from './controller.js';
import { icon } from '../icons.js';
import { LAYERS, nextOverlay } from '../layers.js';

/**
 * @param {{onChange?: (overlayId: string|null) => void}} [options]
 */
export function initLayers({ onChange } = {}) {
  const buttons = document.getElementById('layerbtns');
  const legend = document.getElementById('layerlegend');
  buttons.innerHTML = '';
  legend.innerHTML = '';

  for (const layer of LAYERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-btn';
    btn.dataset.layer = layer.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `${icon(layer.icon)}<span class="label">${layer.label}</span>`;
    btn.title = `Show the ${layer.label.toLowerCase()} layer`;
    btn.addEventListener('click', () => {
      const next = nextOverlay(ui.overlay, layer.id);
      ui.set({ overlay: next });
      onChange?.(next);
    });
    buttons.appendChild(btn);

    // Legend rows, one per band, each with a written label.
    const block = document.createElement('div');
    block.className = 'legend-block';
    block.dataset.legend = layer.id;
    block.innerHTML = `<h4>${layer.label}</h4>` + layer.legend.map(entry => `
      <div class="legend-row">
        <span class="legend-swatch tone-${entry.tone}"></span>
        <span class="legend-label">${entry.label}</span>
        <span class="legend-count" data-count="${layer.id}-${entry.key}"></span>
      </div>`).join('');
    legend.appendChild(block);
  }

  const sync = (state) => {
    for (const btn of buttons.querySelectorAll('[data-layer]')) {
      const on = btn.dataset.layer === state.overlay;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    for (const block of legend.querySelectorAll('[data-legend]')) {
      block.hidden = block.dataset.legend !== state.overlay;
    }
    legend.hidden = state.overlay === null;
  };
  ui.subscribe(sync);
  sync(ui.snapshot());

  return {
    /**
     * Writes real counts into the legend so it reports the actual city rather
     * than a static key. Absent data leaves the count blank instead of showing
     * a zero that would read as a measurement.
     */
    refresh(stats = {}) {
      const set = (key, value) => {
        const el = legend.querySelector(`[data-count="${key}"]`);
        if (el) el.textContent = value == null ? '' : String(value);
      };
      const traffic = stats.traffic ?? {};
      for (const band of LAYERS[0].legend) set(`traffic-${band.key}`, traffic[band.key]);
      const access = stats.access ?? {};
      for (const entry of LAYERS[1].legend) set(`access-${entry.key}`, access[entry.key]);
    },
  };
}
