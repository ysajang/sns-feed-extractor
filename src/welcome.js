(() => {
  'use strict';

  const SUPABASE_URL = 'https://cfkznkynuicphreplukr.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNma3pua3ludWljcGhyZXBsdWtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDYxNTMsImV4cCI6MjA5NDg4MjE1M30.Qj-hYjmH5RtBA7FtHaRMzRFIEyRO_EdC2tOTey_i4eY';

  const emailInput = document.getElementById('email-input');
  const emailBtn = document.getElementById('email-btn');
  const emailMsg = document.getElementById('email-msg');

  function showMsg(text, type) {
    emailMsg.textContent = text;
    emailMsg.className = `email-msg ${type}`;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  emailBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();

    if (!email) {
      showMsg('Please enter your email.', 'error');
      return;
    }

    if (!isValidEmail(email)) {
      showMsg('Please enter a valid email address.', 'error');
      return;
    }

    emailBtn.disabled = true;
    emailBtn.textContent = '...';

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          email,
          source: 'chrome_extension_welcome',
          extension_version: '1.5.0'
        })
      });

      if (res.ok || res.status === 201) {
        showMsg('You\'re in! We\'ll keep you posted.', 'success');
        emailInput.value = '';
        emailBtn.textContent = 'Done ✓';

        try {
          await chrome.storage.local.set({ subscribed: true });
        } catch {
          // extension context 밖에서 열린 경우 무시
        }
      } else if (res.status === 409) {
        showMsg('You\'re already subscribed!', 'success');
        emailBtn.textContent = 'Subscribe';
        emailBtn.disabled = false;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      showMsg('Something went wrong. Please try again.', 'error');
      emailBtn.textContent = 'Subscribe';
      emailBtn.disabled = false;
      console.error('[Welcome] Subscribe error:', err);
    }
  });

  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') emailBtn.click();
  });
})();
