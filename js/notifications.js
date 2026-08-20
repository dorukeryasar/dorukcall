import { supabase } from './supabase.js';
import { $, escapeHtml, formatTime } from './utils.js';

export function createNotificationManager(state) {
  let sub = null;
  let soundCtx = null;

  async function requestBrowserPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') return await Notification.requestPermission();
    return Notification.permission;
  }

  function beep(type='message') {
    try {
      soundCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const now = soundCtx.currentTime;
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = type === 'call' ? 660 : 520;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(type === 'call' ? 0.18 : 0.07, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (type === 'call' ? 0.6 : 0.16));
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(now);
      osc.stop(now + (type === 'call' ? 0.62 : 0.18));
    } catch {}
  }

  function browserNotify(title, body, options={}) {
    if (Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: state.avatarUrl || undefined, ...options }); } catch {}
  }

  async function load() {
    const { data, error } = await supabase
      .from('notifications').select('*').eq('user_id', state.user.id)
      .order('created_at', { ascending: false }).limit(50);
    if (!error) state.notifications = data || [];
    renderBadge();
  }

  function unreadCount() { return state.notifications.filter(n => !n.is_read).length; }

  function renderBadge() {
    const badge = $('#notifBadge');
    const count = unreadCount();
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.toggle('hidden', !count);
  }

  async function markRead(id) {
    const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', state.user.id);
    if (!error) {
      const n = state.notifications.find(x => x.id === id);
      if (n) n.is_read = true;
      renderBadge();
    }
  }

  async function markAllRead() {
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', state.user.id).eq('is_read', false);
    state.notifications.forEach(n => n.is_read = true);
    renderBadge();
  }

  function renderPanel() {
    const list = state.notifications.length ? state.notifications.map(n => `
      <button class="list-item ${n.is_read ? '' : 'highlight'}" data-notification-id="${n.id}" style="text-align:left">
        <span class="grow"><strong>${escapeHtml(n.title)}</strong><small>${escapeHtml(n.body || '')} • ${formatTime(n.created_at)}</small></span>
      </button>`).join('') : `<div class="muted" style="padding:18px;text-align:center">Henüz bildirimin yok.</div>`;

    return `<div class="modal-backdrop" data-modal="notifications">
      <div class="modal sm">
        <div class="modal-head"><h3>Bildirimler</h3><button class="icon-btn" data-close-modal>×</button></div>
        <div class="row" style="margin-bottom:10px"><span class="muted">${unreadCount()} okunmamış</span><button class="secondary-btn" data-mark-all-read>Hepsini okundu yap</button></div>
        <div class="list">${list}</div>
      </div>
    </div>`;
  }

  function bindRealtime() {
    sub = supabase.channel(`notifications:${state.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.user.id}` }, payload => {
        state.notifications.unshift(payload.new);
        renderBadge();
        beep(payload.new.type?.includes('call') ? 'call' : 'message');
        browserNotify(payload.new.title, payload.new.body);
        state.onNotificationsChanged?.(payload.new);
      })
      .subscribe();
  }

  return {
    async start() {
      await load();
      bindRealtime();
      window.addEventListener('dorukcall:request-notification-permission', requestBrowserPermission);
    },
    open() {
      state.openModal?.(renderPanel());
      setTimeout(() => {
        document.querySelectorAll('[data-notification-id]').forEach(el => el.addEventListener('click', async () => {
          await markRead(el.dataset.notificationId);
          state.openModal?.(renderPanel());
        }));
        document.querySelector('[data-mark-all-read]')?.addEventListener('click', async () => {
          await markAllRead(); state.openModal?.(renderPanel());
        });
      });
    },
    renderBadge,
    stop() { if (sub) supabase.removeChannel(sub); }
  };
}
