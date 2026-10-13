// UI helpers — toasts, inspect panel.
export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 2600);
  setTimeout(() => el.remove(), 3100);
  while (box.children.length > 4) box.firstChild.remove();
}

export function openInspect(title, bodyHTML, onChange) {
  const panel = document.getElementById('inspect');
  document.getElementById('insTitle').textContent = title;
  const body = document.getElementById('insBody');
  body.innerHTML = bodyHTML;
  panel.classList.add('open');
  if (onChange) {
    body.querySelectorAll('input[type=range]').forEach(inp => {
      inp.addEventListener('input', () => onChange(inp.dataset.key, parseFloat(inp.value)));
    });
  }
}

export function closeInspect() {
  document.getElementById('inspect').classList.remove('open');
}

export function inspectOpen() {
  return document.getElementById('inspect').classList.contains('open');
}
