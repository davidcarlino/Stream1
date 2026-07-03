// Small DOM + feedback helpers shared by all views.

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(message, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'err' ? 5000 : 3000);
}

export function mount(node) {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(node);
}

// Promise-based modal. `render(close)` returns the modal body element.
export function modal(render) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const overlay = h('<div class="modal-overlay"></div>');
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    const box = h('<div class="modal"></div>');
    box.appendChild(render(close));
    overlay.appendChild(box);
    root.appendChild(overlay);
  });
}

export async function confirmDialog(title, message, { danger = false, confirmText = 'Confirm' } = {}) {
  return modal((close) => {
    const el = h(`<div>
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-outline" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : ''}" data-ok>${esc(confirmText)}</button>
      </div>
    </div>`);
    el.querySelector('[data-cancel]').onclick = () => close(false);
    el.querySelector('[data-ok]').onclick = () => close(true);
    return el;
  });
}

// Toggle a button into a loading state and back.
export function busy(btn, on, labelWhenIdle) {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.disabled = false;
    btn.innerHTML = labelWhenIdle || btn.dataset.label || 'Done';
  }
}

export function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  return Promise.resolve(false);
}
