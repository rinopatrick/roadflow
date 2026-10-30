// Template panel. Owns the template list DOM + rotation + placement hint.
// The world commit stays in main via ctx.runCommand; camera via ctx.camPos().
import { builtinTemplates, transformTemplate, templateCommand, ROTATION_STEP_DEG } from './templates.js';
import { showPanel } from './ui.js';
import { sfx } from './audio.js';

const TEMPLATES = builtinTemplates();
let templateAngle = 0;

export function templateAngleDeg() { return templateAngle; }
export function templateList() {
  return TEMPLATES.map(t => ({ name: t.name, segments: t.segments.length }));
}

function setTemplateHint(text, warn) {
  const el = document.getElementById('tplHint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', !!warn);
}

export function showTemplates(visible, onShow) {
  const pop = document.getElementById('tplpop');
  const btn = document.getElementById('tplbtn');
  if (!pop || !btn) return;
  pop.hidden = !visible;
  btn.setAttribute('aria-expanded', String(visible));
  if (visible) { showPanel(null); renderTemplateList(); onShow?.(); }
}

function renderTemplateList() {
  const list = document.getElementById('tpllist');
  if (!list) return;
  list.innerHTML = '';
  for (const t of TEMPLATES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-btn';
    btn.dataset.template = t.name;
    btn.textContent = t.name;
    btn.addEventListener('click', () => placeTemplate(t, window.__rf_ctx));
    list.appendChild(btn);
  }
  document.getElementById('tplAngle').textContent = templateAngle + '°';
}

export function placeTemplate(template, ctx) {
  const cam = ctx.camPos();
  const placed = transformTemplate(template, {
    rotateDeg: templateAngle,
    dx: cam.x,
    dy: cam.y,
  });
  if (!placed.ok) { setTemplateHint(placed.reason, true); return; }
  const result = ctx.runCommand(templateCommand(placed.template));
  if (!result) {
    setTemplateHint('that template does not fit here', true);
    return;
  }
  sfx.place();
  setTemplateHint(placed.template.name + ' placed.', false);
  showTemplates(false);
}

export function placeTemplateByName(name, ctx) {
  const t = TEMPLATES.find(x => x.name === name);
  if (!t) return false;
  placeTemplate(t, ctx);
  return true;
}

export function initTemplatePanel(ctx) {
  window.__rf_ctx = ctx;
  document.getElementById('tplbtn')?.addEventListener('click', () => {
    showTemplates(document.getElementById('tplpop').hidden);
    sfx.click();
  });
  document.getElementById('tplRotL')?.addEventListener('click', () => {
    templateAngle = ((templateAngle - ROTATION_STEP_DEG) % 360 + 360) % 360;
    renderTemplateList();
    sfx.click();
  });
  document.getElementById('tplRotR')?.addEventListener('click', () => {
    templateAngle = (templateAngle + ROTATION_STEP_DEG) % 360;
    renderTemplateList();
    sfx.click();
  });
}
