(() => {
  const gate = document.getElementById('gate');
  if (!gate) return;

  const CLARITY_ID = window.QCR_CLARITY_ID || '';
  const CLARITY_HOSTS = new Set(['tz-uk.github.io']);
  const loadClarity = () => {
    if (!CLARITY_ID || window.__qcrClarity) return;
    if (navigator.webdriver || !CLARITY_HOSTS.has(location.hostname)) return;
    window.__qcrClarity = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = `https://www.clarity.ms/tag/${i}`;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  };

  // Clarity covers the gate too; the password field is data-clarity-mask'd.
  loadClarity();

  if (sessionStorage.getItem('qcr-gate') === '1') {
    gate.remove();
    loadClarity();
    return;
  }

  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-pass');
  const error = document.getElementById('gate-error');
  const LEGACY = 'efaa190af9404d1e754fee13b30be8a8dff4b9473ff8312e700256238911ca0b';
  const hashes = new Set([LEGACY]);

  const ready = fetch(`./passwords.json?ts=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => {
      if (Array.isArray(list)) {
        for (const entry of list) if (entry && entry.hash) hashes.add(entry.hash);
      }
    })
    .catch(() => {});

  const hex = async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      await ready;
      if (hashes.has(await hex(input.value))) {
        sessionStorage.setItem('qcr-gate', '1');
        gate.remove();
        loadClarity();
      } else {
        error.textContent = 'Wrong password';
        input.select();
      }
    } catch {
      error.textContent = 'Unable to verify';
    }
  });
})();
