import { supabase } from './supabase.js';
import { $, humanError } from './utils.js';

export function initAuth({ onAuthenticated, onLoggedOut }) {
  const authForm = $('#authForm');
  const modeLabel = $('#authModeLabel');
  const nameField = $('#nameField');
  const nameInput = $('#nameInput');
  const submit = $('#authSubmit');
  const switchBtn = $('#switchAuth');
  const forgotBtn = $('#forgotBtn');
  const errorBox = $('#authError');
  let mode = 'login';

  function setError(msg='') { errorBox.textContent = msg; }

  switchBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    const isSignup = mode === 'signup';
    nameField.classList.toggle('hidden', !isSignup);
    nameInput.required = isSignup;
    modeLabel.textContent = isSignup ? 'Yeni hesabını oluştur' : 'Hesabına giriş yap';
    submit.textContent = isSignup ? 'Hesap oluştur' : 'Giriş yap';
    switchBtn.textContent = isSignup ? 'Zaten hesabım var' : 'Yeni hesap oluştur';
    forgotBtn.classList.toggle('hidden', isSignup);
    setError('');
  });

  forgotBtn.addEventListener('click', async () => {
    setError('');
    const email = $('#emailInput').value.trim();
    if (!email) return setError('Şifre sıfırlamak için e-posta adresini yaz.');
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}?reset=1`
    });
    if (error) return setError(humanError(error));
    setError('Şifre sıfırlama bağlantısı e-postana gönderildi.');
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    submit.disabled = true;
    try {
      const email = $('#emailInput').value.trim();
      const password = $('#passwordInput').value;
      if (mode === 'signup') {
        const name = nameInput.value.trim();
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
        if (error) throw error;
        if (data.session) await onAuthenticated(data.session.user);
        else setError('Kayıt tamamlandı. E-postanı doğruladıktan sonra giriş yap.');
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await onAuthenticated(data.user);
      }
    } catch (error) {
      setError(humanError(error));
    } finally {
      submit.disabled = false;
    }
  });

  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) onAuthenticated(session.user);
    else onLoggedOut();
  });
}
