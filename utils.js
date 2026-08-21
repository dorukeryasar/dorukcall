export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const diff = now - d;
  if (diff < 60_000) return 'şimdi';
  if (diff < 3_600_000) return `${Math.floor(diff/60_000)} dk`;
  if (d.toDateString() === now.toDateString()) return formatTime(iso);
  return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit' }).format(d);
}

export function initials(name = '?') {
  return name.split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]?.toUpperCase()).join('') || '?';
}

export function avatarMarkup(url, name, cls='avatar') {
  if (url) return `<img class="${cls}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`;
  return `<div class="${cls} avatar-fallback" aria-hidden="true">${escapeHtml(initials(name))}</div>`;
}

export function debounce(fn, delay=250) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

export function formatDuration(seconds=0) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
           : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

export function humanError(error) {
  const msg = String(error?.message || error || '');
  const code = String(error?.code || '');
  const details = String(error?.details || '');
  const hint = String(error?.hint || '');
  const map = [
    [/Invalid login credentials/i, 'E-posta veya şifre hatalı.'],
    [/User already registered/i, 'Bu e-posta zaten kayıtlı.'],
    [/Password should be at least/i, 'Şifre en az 8 karakter olmalı.'],
    [/Email not confirmed/i, 'Önce e-posta adresini doğrula.'],
    [/rate limit/i, 'Çok fazla deneme yapıldı. Biraz sonra tekrar dene.'],
    [/permission denied|not authorized|row-level security|42501/i, 'Bu işlem için yetkin yok. Supabase RLS politikalarını kontrol et.'],
    [/42703|column .* does not exist/i, 'Supabase veritabanı şeması güncel değil. Yeni schema-fixed.sql dosyasını çalıştır.'],
    [/42P01|relation .* does not exist/i, 'Supabase tablosu eksik. Yeni schema-fixed.sql dosyasını çalıştır.'],
    [/23505|duplicate key|already exists/i, 'Bu kayıt zaten mevcut. Tekrar denemeden önce sohbet listesini yenile.'],
    [/PGRST116|JSON object requested/i, 'Aranan kayıt bulunamadı veya yetkin olmayan bir kayda erişildi.'],
    [/network|fetch/i, 'Ağ bağlantısını kontrol et.'],
    [/camera|microphone|NotAllowedError/i, 'Kamera veya mikrofon izni verilmedi.'],
  ];
  const friendly = map.find(([re]) => re.test(msg) || re.test(code))?.[1];
  if (friendly) return friendly;
  if (msg) {
    const clean = msg.replace(/\s+/g, ' ').trim();
    const extra = [details, hint].filter(Boolean).join(' ');
    return `İşlem başarısız${code ? ` (${code})` : ''}: ${clean.slice(0, 180)}${extra ? ` — ${extra.slice(0, 180)}` : ''}`;
  }
  return 'İşlem sırasında bir hata oluştu.';
}
