(() => {
  const gate = document.getElementById('gate');
  if (!gate) return;
  if (sessionStorage.getItem('qcr-gate') === '1') {
    gate.remove();
    return;
  }
  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-pass');
  const error = document.getElementById('gate-error');
  const HASH = 'efaa190af9404d1e754fee13b30be8a8dff4b9473ff8312e700256238911ca0b';

  const hex = async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      if (await hex(input.value) === HASH) {
        sessionStorage.setItem('qcr-gate', '1');
        gate.remove();
      } else {
        error.textContent = 'Wrong password';
        input.select();
      }
    } catch {
      error.textContent = 'Unable to verify';
    }
  });
})();
