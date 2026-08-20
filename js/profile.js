import { supabase } from './supabase.js';
import { $, escapeHtml, avatarMarkup, humanError } from './utils.js';

export async function loadMyProfile(state) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id',state.user.id).single();
  if (error) throw error;
  Object.assign(state,{profile:data,name:data.name,avatarUrl:data.avatar_url});
  return data;
}

export function openSettings(state, ui) {
  function render() {
    const p=state.profile;
    ui.openModal(`<div class="modal-backdrop" data-modal="settings"><div class="modal">
      <div class="modal-head"><h3>Ayarlar</h3><button class="icon-btn" data-close-modal>×</button></div>
      <div class="settings-grid">
        <div class="settings-nav">
          <button class="active" data-tab="profile">Profil</button><button data-tab="appearance">Görünüm</button><button data-tab="account">Hesap</button>
        </div>
        <div class="settings-content">
          <div data-pane="profile">
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">${avatarMarkup(p.avatar_url,p.name,'avatar xl')}<div><strong>${escapeHtml(p.name)}</strong><div class="muted">${escapeHtml(p.email||state.user.email)}</div></div></div>
            <div class="field"><label>Ad</label><input id="settingsName" value="${escapeHtml(p.name)}" maxlength="80"></div>
            <div class="field"><label>Profil fotoğrafı</label><input id="settingsAvatar" type="file" accept="image/png,image/jpeg,image/webp"></div>
            <button id="saveProfileBtn" class="primary-btn">Profili kaydet</button>
          </div>
          <div data-pane="appearance" class="hidden">
            <div class="muted" style="margin-bottom:12px">Tema tercihin cihazında saklanır.</div>
            <div class="theme-row">
              ${['light','dark'].map(t=>`<button class="theme-pill ${state.theme===t?'active':''}" data-theme-choice="${t}">${t==='light'?'Açık':'Koyu'} tema</button>`).join('')}
            </div>
          </div>
          <div data-pane="account" class="hidden">
            <div class="stack">
              <div class="list-item"><span class="grow"><strong>E-posta</strong><small>${escapeHtml(state.user.email||'')}</small></span></div>
              <button id="changePasswordBtn" class="secondary-btn">Şifre değiştir</button>
              <button id="requestNotifyBtn" class="secondary-btn">Bildirim izni iste</button>
              <button id="logoutBtn" class="danger-btn">Çıkış yap</button>
            </div>
          </div>
        </div>
      </div>
    </div></div>`);
    document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
      document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('active'));b.classList.add('active');
      document.querySelectorAll('[data-pane]').forEach(x=>x.classList.add('hidden'));document.querySelector(`[data-pane="${b.dataset.tab}"]`).classList.remove('hidden');
    }));
    document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>setTheme(state,b.dataset.themeChoice,render,ui)));
    $('#saveProfileBtn').onclick=async()=>{
      try{
        const name=$('#settingsName').value.trim(); if(name.length<2)throw new Error('İsim çok kısa.');
        let avatarUrl=p.avatar_url;
        const file=$('#settingsAvatar').files[0];
        if(file){
          if(file.size>5*1024*1024)throw new Error('Profil fotoğrafı 5 MB altında olmalı.');
          const ext=(file.name.split('.').pop()||'jpg').toLowerCase();const path=`${state.user.id}/avatar.${ext}`;
          const {error:uploadError}=await supabase.storage.from('avatars').upload(path,file,{upsert:true,contentType:file.type,cacheControl:'3600'});if(uploadError)throw uploadError;
          const {data:urlData}=supabase.storage.from('avatars').getPublicUrl(path);avatarUrl=`${urlData.publicUrl}?v=${Date.now()}`;
        }
        const {error}=await supabase.from('profiles').update({name,avatar_url:avatarUrl,updated_at:new Date().toISOString()}).eq('id',state.user.id);if(error)throw error;
        state.name=name;state.avatarUrl=avatarUrl;state.profile={...state.profile,name,avatar_url:avatarUrl};ui.refreshMe?.();ui.toast('Profil güncellendi.');render();
      }catch(e){ui.toast(humanError(e));}
    };
    $('#changePasswordBtn')?.addEventListener('click',async()=>{const pw=prompt('Yeni şifre (en az 8 karakter):');if(!pw)return;const {error}=await supabase.auth.updateUser({password:pw});if(error)ui.toast(humanError(error));else ui.toast('Şifren güncellendi.');});
    $('#requestNotifyBtn')?.addEventListener('click',async()=>{const r=await window.dispatchEvent(new CustomEvent('dorukcall:request-notification-permission'));ui.toast('Tarayıcı bildirimi ayarı açıldıysa izin verebilirsin.');});
    $('#logoutBtn')?.addEventListener('click',()=>supabase.auth.signOut());
    document.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click',ui.closeModal));
  }
  render();
}

export function setTheme(state, theme, rerender, ui) {
  state.theme=theme; localStorage.setItem('dorukcall-theme',theme);document.documentElement.dataset.theme=theme;rerender?.();ui.refreshMe?.();
}
