// Tableau de bord pâtisserie.
;(function () {
  const api = window.API
  const app = document.getElementById('app')
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch { /* stockage indisponible */ } },
  }

  const S = {
    lang: store.get('lang') === 'ar' ? 'ar' : 'fr',
    session: null,
    role: null,
    view: 'orders',
    data: { settings: {}, orders: [], drivers: [], staff: [], counters: [] },
    modal: null,
    qr: null,
    hist: { day: localDay(new Date()), rows: null },
    login: { mode: 'in', msg: '' },
    form: null,
    busy: false,
  }

  // ---------------------------------------------------------------- outils
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const t = (k, v = {}) => (window.I18N[S.lang][k] ?? window.I18N.fr[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '')
  const amount = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '')
  const money = (n) => `<span class="num">${amount(n)}</span> ${t('mad')}`
  const locale = () => (S.lang === 'ar' ? 'ar-MA' : 'fr-FR')
  const hm = (d) => new Date(d).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const minsSince = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  const driverOf = (o) => S.data.drivers.find((d) => d.id === o.driver_id)
  const isOwner = () => S.role === 'owner'
  const countersOf = (o) => (S.data.counters || []).filter((c) => c.order_id === o.id)
  const trackUrl = (o) => new URL(`track.html#${o.track_token}`, location.href).href
  const waLink = (o) => `https://wa.me/${String(o.customer_phone).replace(/\D/g, '')}?text=${encodeURIComponent(t('track_msg', { shop: S.data.settings.shop_name || '', url: trackUrl(o) }))}`
  function localDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  let toastTimer
  function toast(msg) {
    const el = document.getElementById('toast')
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500)
  }
  function errorText(e) {
    const m = String(e?.message || e)
    if (/Invalid login credentials/i.test(m)) return t('err_login')
    if (/Email not confirmed/i.test(m)) return t('err_unconfirmed')
    if (/Password should be/i.test(m)) return t('err_password_short')
    const code = (m.match(/\b(bad_phone|name_required|amount_required|bad_status|owner_only|staff_only|blocked)\b/) || [])[1]
    return code ? t('err_' + code) : t('err_generic')
  }
  async function run(fn, okMsg) {
    if (S.busy) return false
    S.busy = true
    try {
      await fn()
      if (okMsg) toast(okMsg)
      return true
    } catch (e) {
      console.error(e)
      toast(errorText(e))
      return false
    } finally {
      S.busy = false
    }
  }

  function normPhone(raw) {
    let p = String(raw || '').replace(/[^\d+]/g, '')
    if (p.startsWith('00')) p = '+' + p.slice(2)
    if (p.startsWith('212')) p = '+' + p
    if (/^0[5-7]\d{8}$/.test(p)) p = '+212' + p.slice(1)
    if (/^[5-7]\d{8}$/.test(p)) p = '+212' + p
    return p
  }
  // Trouve des coordonnées dans un texte collé (coordonnées brutes ou lien Google Maps long).
  function parseLocation(text) {
    const s = String(text || '').trim()
    if (!s) return null
    const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/]
    for (const re of pats) {
      const m = s.match(re)
      if (m) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2])
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }
      }
    }
    return /^https?:\/\//i.test(s) ? { url: s } : null
  }
  const mapLink = (o) => (o.lat != null && o.lng != null ? `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}` : o.maps_url)

  // Alertes : personne n'accepte / livreur en retard.
  function alertsOf(o) {
    const s = S.data.settings
    if (o.status === 'broadcast' && o.last_ring_at && Date.now() - new Date(o.last_ring_at) > (s.no_accept_alert_seconds || 180) * 1000) return 'no_driver'
    if (o.status === 'accepted' && o.eta_at && Date.now() - new Date(o.eta_at) > (s.late_tolerance_minutes || 5) * 60000) return 'late'
    return null
  }
  let lastAlertCount = 0
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.frequency.value = 880
      osc.connect(gain)
      gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0.2, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
      osc.start()
      osc.stop(ctx.currentTime + 0.6)
    } catch { /* son indisponible */ }
  }

  // ---------------------------------------------------------------- données
  let loading = null
  async function refresh() {
    if (!S.role || S.role === 'pending') return
    if (!loading) {
      loading = api.load().then((d) => { S.data = d }).catch((e) => console.error(e)).finally(() => { loading = null })
    }
    await loading
    const n = S.data.orders.filter(alertsOf).length
    if (n > lastAlertCount) beep()
    lastAlertCount = n
    render()
  }
  let refreshTimer
  const refreshSoon = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 250)
  }

  async function start() {
    applyLang()
    if (!api) {
      app.innerHTML = `<div class="login"><h1>${t('login_title')}</h1><div class="card">${t('config_missing')}</div></div>`
      return
    }
    try {
      S.session = await api.session()
      if (S.session) S.role = await api.rpc('claim_staff', { p_name: null })
    } catch (e) {
      console.error(e)
      S.session = null
    }
    render(true)
    if (S.role && S.role !== 'pending') {
      await refresh()
      api.subscribe((p) => (p && p.table === 'positions' ? onPosition(p.new) : refreshSoon()))
      setInterval(refresh, 20000)
      setInterval(() => api.rpc('staff_tick').catch(() => {}), 60000)
      setInterval(tickUi, 1000)
      window.addEventListener('online', refresh)
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })
    }
  }

  function applyLang() {
    document.documentElement.lang = S.lang
    document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr'
    document.title = `${t('app_title')} — ${t('login_title')}`
  }

  // ---------------------------------------------------------------- rendu
  const editing = () => {
    const a = document.activeElement
    return a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)
  }
  let map = null
  function render(force) {
    // Les écrans où l'on règle une carte ou un formulaire ne sont jamais redessinés par les mises à jour automatiques.
    if (!force && (editing() || ((S.view === 'new' || S.view === 'settings' || S.view === 'qr') && !S.modal))) return
    // Si l'utilisateur a déplacé ou zoomé la carte, on retrouve la même vue après le rafraîchissement.
    const mapKey = () => S.view + ':' + (S.modal?.id || '')
    const keep = map && map._userMoved ? { key: mapKey(), center: map.getCenter(), zoom: map.getZoom() } : null
    if (map) { map.remove(); map = null }
    if (!S.session) app.innerHTML = viewLogin()
    else if (S.role === 'pending') app.innerHTML = viewPendingStaff()
    else app.innerHTML = viewShell()
    afterRender()
    if (map) {
      if (keep && keep.key === mapKey()) { map.setView(keep.center, keep.zoom, { animate: false }); map._userMoved = true }
      const m = map
      setTimeout(() => m.on('dragstart zoomstart', () => { m._userMoved = true }), 400)
    }
  }

  const langButtons = () => `<div class="langs">
    <button data-act="lang" data-v="fr" class="${S.lang === 'fr' ? 'on' : ''}">Français</button>
    <button data-act="lang" data-v="ar" class="${S.lang === 'ar' ? 'on' : ''}">العربية</button></div>`

  function viewLogin() {
    const up = S.login.mode === 'up'
    return `<div class="login">${langButtons()}<h1>${t('login_title')}</h1>
      <form class="card" data-form="login">
        ${up ? `<label for="l-name">${t('your_name')}</label><input id="l-name" name="name" autocomplete="name" required>` : ''}
        <label for="l-email">${t('email')}</label><input id="l-email" name="email" type="email" autocomplete="username" required dir="ltr">
        <label for="l-pw">${t('password')}</label><input id="l-pw" name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="8" required dir="ltr">
        ${S.login.msg ? `<p class="hint ok">${esc(S.login.msg)}</p>` : ''}
        <div class="btns"><button class="btn primary block">${t(up ? 'sign_up' : 'sign_in')}</button></div>
      </form>
      <div style="text-align:center"><button class="linkbtn" data-act="login-mode">${t(up ? 'have_account' : 'no_account')}</button></div></div>`
  }

  function viewPendingStaff() {
    return `<div class="login">${langButtons()}<h1>${t('pending_staff_title')}</h1>
      <div class="card">${t('pending_staff_text')}</div>
      <button class="btn block" data-act="logout">${t('logout')}</button></div>`
  }

  const ICONS = {
    orders: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    drivers: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  }
  function viewShell() {
    const views = { orders: viewOrders, new: viewNew, drivers: viewDrivers, qr: viewQr, history: viewHistory, settings: viewSettings }
    const pending = S.data.drivers.filter((d) => d.status === 'pending').length
    const alerts = S.data.orders.filter(alertsOf).length + (S.data.counters || []).length
    const tab = (k, badge) => `<button data-act="nav" data-v="${k}" class="${S.view === k || (k === 'orders' && S.view === 'new') ? 'on' : ''}">
      ${badge ? `<span class="badge">${badge}</span>` : ''}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>
      <span>${t('nav_' + k)}</span></button>`
    return `${api.demo ? `<div class="banner">${t('demo_banner')}</div>` : ''}
      <main class="shell">${views[S.view]()}</main>
      <nav class="nav">${tab('orders', alerts)}${tab('drivers', pending)}${tab('qr')}${tab('history')}${tab('settings')}</nav>
      ${S.modal ? viewModal() : ''}`
  }

  // ---- Commandes
  function orderLine(o) {
    const d = driverOf(o)
    if (o.status === 'broadcast') return `${t('waiting_since')} <span class="num">${minsSince(o.last_ring_at || o.created_at)}</span> ${t('min')}`
    if (o.status === 'accepted') {
      const left = Math.ceil((new Date(o.eta_at) - Date.now()) / 60000)
      return `<bdi>${esc(d?.name || '')}</bdi> · ${left >= 0 ? `${t('arrives_in')} <span class="num">${left}</span> ${t('min')}` : `${t('late_by')} <span class="num">${-left}</span> ${t('min')}`}`
    }
    if (o.status === 'at_shop') return `<bdi>${esc(d?.name || '')}</bdi> · ${t(o.payment_confirmed_at ? 'payment_ok' : 'payment_wait')}`
    if (d) return `<bdi>${esc(d.name)}</bdi>`
    return ''
  }
  // Propositions de prix des livreurs sur une commande en attente.
  function counterBlock(o) {
    return countersOf(o).map((c) => {
      const d = S.data.drivers.find((x) => x.id === c.driver_id)
      return `<div class="card alert warn" style="margin:8px 0 0"><div class="title small">${t('counter_title')}</div>
        <div><bdi>${esc(d?.name || '')}</bdi> · ${d ? ratingText(d) : ''} · ${t('counter_asks')} <b>${money(c.gain)}</b> <span class="muted small">(${t('counter_now')} ${money(o.driver_gain)})</span></div>
        <div class="btns"><button class="btn ok" data-act="counter-accept" data-id="${o.id}" data-c="${c.id}">${t('counter_accept')}</button>
        <button class="btn danger" data-act="counter-refuse" data-c="${c.id}">${t('refuse')}</button></div></div>`
    }).join('')
  }
  function orderCard(o) {
    const a = alertsOf(o)
    const head = `<div class="row"><div class="grow"><div class="title">#<span class="num">${o.number}</span> · <bdi>${esc(o.customer_name)}</bdi></div>
      <div class="small muted">${orderLine(o)}</div></div>
      <div style="text-align:end"><span class="chip ${o.status}">${t('st_' + o.status)}</span>
      <div class="small muted" style="margin-top:4px">${money(o.collect_from_customer)}</div></div></div>`
    if (!a) return `<button class="card" data-act="open-order" data-id="${o.id}">${head}</button>${counterBlock(o)}`
    const btns = a === 'no_driver'
      ? `<button class="btn" data-act="raise" data-id="${o.id}" data-n="5"><span class="num">+5</span> ${t('mad')}</button>
         <button class="btn" data-act="raise" data-id="${o.id}" data-n="10"><span class="num">+10</span> ${t('mad')}</button>
         <button class="btn" data-act="ring" data-id="${o.id}">${t('ring_again')}</button>`
      : `<button class="btn danger" data-act="reassign" data-id="${o.id}">${t('reassign')}</button>
         <a class="btn" href="tel:${esc(driverOf(o)?.phone || '')}">${t('call')}</a>`
    return `<div class="card alert ${a === 'no_driver' ? 'warn' : ''}">
      <div class="title small">${t(a === 'no_driver' ? 'alert_no_driver' : 'alert_late')}</div>
      <button class="card" style="margin:8px 0 0" data-act="open-order" data-id="${o.id}">${head}</button>
      <div class="btns">${btns}</div>${counterBlock(o)}</div>`
  }
  function viewOrders() {
    const rank = { broadcast: 0, created: 0, accepted: 1, at_shop: 1, picked_up: 2, delivered: 3, cancelled: 4 }
    const list = [...S.data.orders].sort((a, b) => (alertsOf(b) ? 1 : 0) - (alertsOf(a) ? 1 : 0) || rank[a.status] - rank[b.status] || new Date(b.created_at) - new Date(a.created_at))
    return `<div class="topbar"><h1>${esc(S.data.settings.shop_name || t('nav_orders'))}</h1></div>
      ${list.length ? list.map(orderCard).join('') : `<div class="empty">${t('no_orders')}</div>`}
      <button class="fab" data-act="nav" data-v="new">+ ${t('new_order')}</button>`
  }

  // ---- Nouvelle commande
  function moneySummary(o) {
    const base = o.prepaid ? 0 : Number(o.amount || 0)
    const pay = base - Number(o.shop_bonus || 0)
    return `<div class="kv"><span>${t(pay >= 0 ? 'm_pay' : 'm_give')}</span><b>${money(Math.abs(pay))}</b></div>
      <div class="kv"><span>${t('m_collect')}</span><b>${money(base + Number(o.delivery_fee || 0))}</b></div>
      <div class="kv strong"><span>${t('m_gain')}</span><b>${money(Number(o.delivery_fee || 0) + Number(o.shop_bonus || 0))}</b></div>`
  }
  function viewNew() {
    S.form = S.form || { loc: null }
    return `<div class="topbar"><h1>${t('new_order')}</h1><button class="btn" data-act="nav" data-v="orders">${t('back')}</button></div>
      <form data-form="order" class="card" novalidate>
        <label for="f-ref">${t('f_ref')}</label><input id="f-ref" name="external_ref" dir="ltr" autocomplete="off">
        <label for="f-name">${t('f_name')}</label><input id="f-name" name="customer_name" required autocomplete="off">
        <label for="f-phone">${t('f_phone')}</label><input id="f-phone" name="customer_phone" type="tel" inputmode="tel" placeholder="+212 6XX XX XX XX" dir="ltr" required autocomplete="off">
        <label for="f-area">${t('f_area')}</label><input id="f-area" name="area" autocomplete="off">
        <label for="f-addr">${t('f_address')}</label><textarea id="f-addr" name="address_text" rows="2"></textarea>
        <label for="f-loc">${t('f_location')}</label><input id="f-loc" name="location" dir="ltr" autocomplete="off">
        <div class="hint" id="loc-hint">${t('f_location_hint')}</div>
        <div id="map" class="map"></div>
        <div class="grid2">
          <div><label for="f-amount">${t('m_amount')}</label><input id="f-amount" name="amount" type="number" inputmode="decimal" min="0" step="0.01" required dir="ltr"></div>
          <div><label for="f-fee">${t('m_fee')}</label><input id="f-fee" name="delivery_fee" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" dir="ltr"></div>
        </div>
        <label for="f-bonus">${t('m_bonus')}</label><input id="f-bonus" name="shop_bonus" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" dir="ltr">
        <label class="check"><input type="checkbox" name="prepaid"> <span>${t('prepaid')}</span></label>
        <label for="f-note">${t('f_note')}</label><textarea id="f-note" name="note" rows="2"></textarea>
        <div class="summary" id="summary">${moneySummary({})}</div>
        <div class="btns"><button class="btn primary block">${t('broadcast')}</button></div>
      </form>`
  }
  function readOrderForm(form) {
    const f = new FormData(form)
    const num = (k) => (f.get(k) === '' || f.get(k) === null ? null : Number(f.get(k)))
    const loc = S.form?.loc || {}
    return {
      external_ref: f.get('external_ref').trim(), customer_name: f.get('customer_name').trim(),
      customer_phone: normPhone(f.get('customer_phone')), area: f.get('area').trim(), address_text: f.get('address_text').trim(),
      lat: loc.lat ?? null, lng: loc.lng ?? null, maps_url: loc.url ?? null,
      amount: num('amount'), delivery_fee: num('delivery_fee') ?? 0, shop_bonus: num('shop_bonus') ?? 0,
      prepaid: f.get('prepaid') === 'on', note: f.get('note').trim(),
    }
  }
  function setLocation(loc, moveMap) {
    S.form.loc = loc
    const hint = document.getElementById('loc-hint')
    if (!hint) return
    hint.className = 'hint' + (loc ? ' ok' : '')
    hint.textContent = !loc ? t('f_location_hint') : loc.url ? t('f_location_link') : `${t('f_location_ok')} (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`
    if (map && loc && loc.lat != null) {
      map._pin = map._pin ? map._pin.setLatLng([loc.lat, loc.lng]) : L.circleMarker([loc.lat, loc.lng], { radius: 9, color: '#b8245c', fillOpacity: 0.8 }).addTo(map)
      if (moveMap) map.setView([loc.lat, loc.lng], 16)
    }
  }
  function makeMap(onPick, pin) {
    const el = document.getElementById('map')
    if (!el || !window.L) return
    const s = S.data.settings
    const center = pin || (s.shop_lat != null ? [s.shop_lat, s.shop_lng] : [31.8, -7.1])
    map = L.map(el).setView(center, pin || s.shop_lat != null ? 14 : 6)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
    if (pin) map._pin = L.circleMarker(pin, { radius: 9, color: '#b8245c', fillOpacity: 0.8 }).addTo(map)
    map.on('click', (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }))
  }

  // ---- Livreurs
  function driverState(d) {
    if (d.status !== 'active') return `<span class="chip ${d.status}">${t('ds_' + d.status)}</span>`
    const busy = S.data.orders.some((o) => o.driver_id === d.id && ['accepted', 'at_shop', 'picked_up'].includes(o.status))
    return `<span class="small"><span class="dot ${busy ? 'busy' : d.online ? 'on' : ''}"></span>${t(busy ? 'on_delivery' : d.online ? 'online' : 'offline')}</span>`
  }
  const ratingText = (d) => (d.rating_avg != null ? `★ <span class="num">${Number(d.rating_avg).toFixed(1)}</span>` : t('new_label'))
  function viewDrivers() {
    const pending = S.data.drivers.filter((d) => d.status === 'pending')
    const others = S.data.drivers.filter((d) => d.status !== 'pending' && d.status !== 'rejected')
    return `<div class="topbar"><h1>${t('nav_drivers')}</h1></div>
      <h3>${t('pending_drivers')}</h3>
      ${pending.length ? pending.map((d) => `<div class="card"><div class="title"><bdi>${esc(d.name)}</bdi></div>
        <div class="small muted"><span class="num">${esc(d.phone)}</span>${d.device_model ? ' · ' + esc(d.device_model) : ''}</div>
        <div class="btns"><button class="btn ok" data-act="driver-status" data-id="${d.id}" data-v="active">${t('validate')}</button>
        <button class="btn danger" data-act="driver-status" data-id="${d.id}" data-v="rejected">${t('refuse')}</button>
        <a class="btn" href="tel:${esc(d.phone)}">${t('call')}</a></div></div>`).join('') : `<div class="card muted">${t('no_pending')}</div>`}
      <h3>${t('all_drivers')}</h3>
      ${others.length ? others.map((d) => `<button class="card" data-act="open-driver" data-id="${d.id}"><div class="row">
        <div class="grow"><div class="title"><bdi>${esc(d.name)}</bdi></div><div class="small muted">${ratingText(d)} · <span class="num">${d.completed_count}</span> ${t('stat_done').toLowerCase()}</div></div>
        ${driverState(d)}</div></button>`).join('') : `<div class="empty">${t('no_drivers')}</div>`}`
  }

  // ---- QR code
  function qrUrl(token) {
    return new URL(`join.html#${token}`, location.href).href
  }
  function viewQr() {
    const q = S.qr
    const valid = q && new Date(q.expires_at) > new Date()
    let svg = ''
    if (valid && window.qrcode) {
      const code = window.qrcode(0, 'M')
      code.addData(qrUrl(q.token))
      code.make()
      svg = code.createSvgTag({ cellSize: 6, margin: 3, scalable: true })
    }
    return `<div class="topbar"><h1>${t('qr_title')}</h1></div>
      ${valid ? `<div class="card qr">${q.name ? `<p class="title"><bdi>${esc(q.name)}</bdi> · <span class="num">${esc(q.phone)}</span></p>` : ''}
        <p class="muted">${t(q.name ? 'qr_text_personal' : 'qr_text')}</p>${svg}
        <p>${t('qr_code')} : <span class="code">${esc(q.token)}</span></p>
        <p class="muted">${t('qr_expires')} <b id="qr-left" class="num"></b></p>
        <button class="btn block" data-act="qr-reset">${t('qr_other')}</button></div>`
      : `<form class="card" data-form="qr"><p class="muted">${t('qr_intro')}</p>
        <label for="q-name">${t('qr_name')}</label><input id="q-name" name="name" autocomplete="off" required>
        <label for="q-phone">${t('qr_phone')}</label><input id="q-phone" name="phone" type="tel" inputmode="tel" placeholder="06 12 34 56 78" dir="ltr" autocomplete="off" required>
        <div class="btns"><button class="btn primary block">${t('qr_generate')}</button></div></form>
        <div style="text-align:center"><button class="linkbtn" data-act="qr-new">${t('qr_blank')}</button></div>`}`
  }

  // ---- Historique
  function viewHistory() {
    const rows = S.hist.rows
    let body = `<div class="empty">…</div>`
    if (rows) {
      const done = rows.filter((o) => o.status === 'delivered')
      const by = {}
      done.forEach((o) => {
        const r = (by[o.driver_id] = by[o.driver_id] || { n: 0, gain: 0, paid: 0 })
        r.n++
        r.gain += Number(o.driver_gain)
        r.paid += Number(o.pay_at_shop)
      })
      const tot = Object.values(by).reduce((a, r) => ({ n: a.n + r.n, gain: a.gain + r.gain, paid: a.paid + r.paid }), { n: 0, gain: 0, paid: 0 })
      body = !rows.length ? `<div class="empty">${t('no_history')}</div>` : `
        <h3>${t('recap')}</h3>
        <div class="card tablewrap"><table><thead><tr><th>${t('driver')}</th><th class="n">${t('recap_count')}</th><th class="n">${t('recap_gain')}</th><th class="n">${t('recap_paid')}</th></tr></thead><tbody>
        ${Object.entries(by).map(([id, r]) => `<tr><td>${esc(S.data.drivers.find((d) => d.id === id)?.name || '—')}</td><td class="n num">${r.n}</td><td class="n">${money(r.gain)}</td><td class="n">${money(r.paid)}</td></tr>`).join('')}
        <tr><th>${t('total')}</th><th class="n num">${tot.n}</th><th class="n">${money(tot.gain)}</th><th class="n">${money(tot.paid)}</th></tr></tbody></table></div>
        <h3>${t('nav_orders')}</h3>
        ${rows.map((o) => `<button class="card" data-act="open-order" data-id="${o.id}"><div class="row"><div class="grow">
          <div class="title">#<span class="num">${o.number}</span> · <bdi>${esc(o.customer_name)}</bdi></div>
          <div class="small muted"><span class="num">${hm(o.created_at)}</span>${driverOf(o) ? ' · ' + esc(driverOf(o).name) : ''}</div></div>
          <div style="text-align:end"><span class="chip ${o.status}">${t('st_' + o.status)}</span><div class="small muted" style="margin-top:4px">${money(o.collect_from_customer)}</div></div></div></button>`).join('')}`
    }
    return `<div class="topbar"><h1>${t('nav_history')}</h1></div>
      <label for="h-day">${t('day')}</label><input id="h-day" type="date" value="${S.hist.day}" data-change="hist-day" dir="ltr">
      ${body}`
  }
  async function loadHistory() {
    S.hist.rows = null
    try {
      S.hist.rows = await api.ordersByDay(S.hist.day)
    } catch (e) {
      S.hist.rows = []
      toast(errorText(e))
    }
    if (S.view === 'history') render(true)
  }

  // ---- Paramètres
  function viewSettings() {
    const s = S.data.settings
    const dis = isOwner() ? '' : 'disabled'
    return `<div class="topbar"><h1>${t('nav_settings')}</h1></div>
      <div class="card"><label for="s-lang" style="margin-top:0">${t('language')}</label>
        <select id="s-lang" data-change="lang"><option value="fr" ${S.lang === 'fr' ? 'selected' : ''}>Français</option><option value="ar" ${S.lang === 'ar' ? 'selected' : ''}>العربية</option></select></div>
      <form class="card" data-form="settings">
        <h2>${t('shop')}</h2>
        ${isOwner() ? '' : `<p class="hint">${t('owner_only_note')}</p>`}
        <label for="s-name">${t('shop_name')}</label><input id="s-name" name="shop_name" value="${esc(s.shop_name)}" ${dis}>
        <label>${t('shop_position')}</label><div id="map" class="map" style="height:320px"></div>
        ${isOwner() ? `<div class="btns"><button type="button" class="btn" data-act="my-position">${t('use_my_position')}</button></div>` : ''}
        <h2 style="margin-top:18px">${t('delays')}</h2>
        <label for="s-alert">${t('d_alert')}</label><input id="s-alert" name="no_accept_alert_seconds" type="number" min="30" max="3600" value="${s.no_accept_alert_seconds}" ${dis} dir="ltr">
        <label for="s-late">${t('d_late')}</label><input id="s-late" name="late_tolerance_minutes" type="number" min="0" max="60" value="${s.late_tolerance_minutes}" ${dis} dir="ltr">
        <label for="s-prio">${t('d_priority')}</label><input id="s-prio" name="priority_seconds" type="number" min="0" max="600" value="${s.priority_seconds}" ${dis} dir="ltr">
        <h2 style="margin-top:18px">${t('counter_h')}</h2>
        <label class="check"><input type="checkbox" name="counter_enabled" ${s.counter_enabled ? 'checked' : ''} ${dis}> <span>${t('counter_enable')}</span></label>
        <label for="s-cd">${t('counter_delay')}</label><input id="s-cd" name="counter_delay_min" type="number" min="0" max="120" value="${Math.round((s.counter_delay_seconds ?? 300) / 60)}" ${dis} dir="ltr">
        ${isOwner() ? `<div class="btns"><button class="btn primary block">${t('save')}</button></div>` : ''}
      </form>
      ${isOwner() ? `<div class="card"><h2>${t('accounts')}</h2>${S.data.staff.map((m) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><div class="title"><bdi>${esc(m.name || m.email || '')}</bdi></div><div class="small muted">${esc(m.email || '')} · ${t('role_' + m.role)}</div></div>
        ${m.role === 'pending' ? `<button class="btn ok" data-act="staff-role" data-id="${m.user_id}" data-v="shop">${t('accept_account')}</button>` : ''}
        ${m.role !== 'owner' ? `<button class="btn danger" data-act="staff-role" data-id="${m.user_id}" data-v="remove">${t('remove_account')}</button>` : ''}</div>`).join('')}</div>` : ''}
      <form class="card" data-form="password"><h2>${t('change_password')}</h2>
        <label for="s-pw">${t('new_password')}</label><input id="s-pw" name="password" type="password" minlength="8" autocomplete="new-password" required dir="ltr">
        <div class="btns"><button class="btn block">${t('save')}</button></div></form>
      <button class="btn block danger" data-act="logout">${t('logout')}</button>`
  }

  // ---- Fenêtres de détail
  function viewModal() {
    const m = S.modal
    const body = m.type === 'order' ? modalOrder(m) : modalDriver(m)
    return `<div class="modal" data-act="close-modal"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`
  }
  function eventText(e) {
    const d = e.data || {}
    return t('ev_' + e.event, { ...d, payer: d.payer ? t('payer_' + d.payer) : '' })
  }
  function modalOrder(m) {
    const o = S.data.orders.find((x) => x.id === m.id) || (S.hist.rows || []).find((x) => x.id === m.id)
    if (!o) return `<button class="btn block" data-act="close-modal" data-x="1">${t('close')}</button>`
    const d = driverOf(o)
    const link = mapLink(o)
    const pay = Number(o.pay_at_shop)
    const allowed = o.counter_allowed ?? S.data.settings.counter_enabled
    const cc = m.counter && (S.data.counters || []).find((c) => c.id === m.counter)
    let actions = ''
    if (cc) {
      actions = `<p class="title">${t('counter_who', { n: amount(cc.gain - o.driver_gain) })}</p><div class="choice">
        <button class="btn" data-act="counter-do" data-v="client">${t('raise_client')}<small>${t('raise_client_hint')}</small></button>
        <button class="btn" data-act="counter-do" data-v="shop">${t('raise_shop')}<small>${t('raise_shop_hint')}</small></button></div>`
    } else if (m.raise) {
      actions = `<p class="title">${t('raise_who', { n: m.raise })}</p><div class="choice">
        <button class="btn" data-act="raise-do" data-v="client">${t('raise_client')}<small>${t('raise_client_hint')}</small></button>
        <button class="btn" data-act="raise-do" data-v="shop">${t('raise_shop')}<small>${t('raise_shop_hint')}</small></button></div>`
    } else if (o.status === 'created' || o.status === 'broadcast') {
      actions = `<div class="btns"><button class="btn" data-act="raise" data-id="${o.id}" data-n="5"><span class="num">+5</span> ${t('mad')}</button>
        <button class="btn" data-act="raise" data-id="${o.id}" data-n="10"><span class="num">+10</span> ${t('mad')}</button>
        <button class="btn" data-act="ring" data-id="${o.id}">${t(o.status === 'created' ? 'broadcast' : 'ring_again')}</button></div>
        ${counterBlock(o)}
        <div class="btns"><button class="btn" data-act="counter-toggle" data-id="${o.id}" data-v="${allowed ? '' : '1'}">${t(allowed ? 'counter_forbid' : 'counter_allow')}</button></div>`
    } else if (o.status === 'accepted' || o.status === 'at_shop') {
      const label = pay > 0 ? t('confirm_payment', { n: amount(pay) }) : pay < 0 ? t('confirm_give', { n: amount(-pay) }) : t('confirm_handover')
      actions = `<div class="btns">${o.payment_confirmed_at ? `<span class="chip delivered">${t('payment_ok')}</span>` : `<button class="btn ok block" data-act="pay" data-id="${o.id}">${label}</button>`}</div>
        <div class="btns"><button class="btn danger" data-act="reassign" data-id="${o.id}">${t('reassign')}</button></div>`
    } else if (o.status === 'delivered') {
      const stars = m.stars ?? m.rating?.stars ?? 0
      actions = `<h3>${t('rate_driver')}</h3><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-act="star" data-n="${n}" class="${n <= stars ? 'on' : ''}" aria-label="${n}">★</button>`).join('')}</div>
        <label for="r-comment">${t('comment')}</label><textarea id="r-comment" rows="2">${esc(m.comment ?? m.rating?.comment ?? '')}</textarea>
        <div class="btns"><button class="btn primary block" data-act="rate" data-id="${o.id}" ${stars ? '' : 'disabled'}>${t('save')}</button></div>`
    }
    const live = ['accepted', 'at_shop', 'picked_up'].includes(o.status)
    const mapBlock = live || o.delivered_lat != null
      ? `<div class="card"><div class="small muted">${live ? (m.pos ? t('pos_live', { t: hm(m.pos.at) }) : t('pos_none')) : t('pos_delivered')}</div><div id="omap" class="map"></div></div>`
      : ''
    const canCancel = !['delivered', 'cancelled'].includes(o.status) && !m.raise && !cc
    return `<div class="row"><h2>${t('order')} #<span class="num">${o.number}</span></h2><span class="chip ${o.status}">${t('st_' + o.status)}</span></div>
      ${o.external_ref ? `<div class="small muted">Feady’s : <span class="num">${esc(o.external_ref)}</span></div>` : ''}
      <div class="card" style="margin-top:12px"><div class="title"><bdi>${esc(o.customer_name)}</bdi></div>
        <div class="small"><a href="tel:${esc(o.customer_phone)}" class="num">${esc(o.customer_phone)}</a></div>
        ${o.area || o.address_text ? `<div class="small muted">${esc([o.area, o.address_text].filter(Boolean).join(' · '))}</div>` : ''}
        ${o.note ? `<div class="small" style="margin-top:6px">${esc(o.note)}</div>` : ''}
        ${link ? `<div class="btns"><a class="btn" target="_blank" rel="noopener" href="${esc(link)}">${t('open_map')}</a></div>` : ''}
        ${o.track_token && !['delivered', 'cancelled'].includes(o.status) ? `<div class="btns"><a class="btn" target="_blank" rel="noopener" href="${esc(waLink(o))}">${t('track_wa')}</a><button class="btn" data-act="track-copy" data-id="${o.id}">${t('track_copy')}</button></div>` : ''}</div>
      <div class="card"><div class="row"><div class="grow"><div class="small muted">${t('driver')}</div><div class="title">${d ? `<bdi>${esc(d.name)}</bdi>` : t('none')}</div></div>
        ${d ? `<a class="btn" href="tel:${esc(d.phone)}">${t('call')}</a>` : ''}</div></div>
      ${mapBlock}
      <div class="card">
        <div class="kv"><span>${t('m_amount')}${o.prepaid ? ` · ${t('prepaid_short')}` : ''}</span><b>${money(o.amount)}</b></div>
        <div class="kv"><span>${t('m_fee')}</span><b>${money(o.delivery_fee)}</b></div>
        ${Number(o.shop_bonus) ? `<div class="kv"><span>${t('m_bonus')}</span><b>${money(o.shop_bonus)}</b></div>` : ''}
        ${moneySummary(o)}</div>
      ${actions}
      <h3>${t('timeline')}</h3>
      <div class="card"><ul class="timeline">${(m.events || []).map((e) => `<li><time class="num">${hm(e.at)}</time><span>${esc(eventText(e))}</span></li>`).join('') || '<li class="muted">…</li>'}</ul></div>
      <div class="btns">${canCancel ? `<button class="btn danger" data-act="cancel" data-id="${o.id}">${t('cancel_order')}</button>` : ''}
        <button class="btn" data-act="close-modal" data-x="1">${t(m.raise || cc ? 'back' : 'close')}</button></div>`
  }
  function modalDriver(m) {
    const d = S.data.drivers.find((x) => x.id === m.id)
    if (!d) return ''
    const stat = (v, k) => `<div class="stat"><b class="num">${v}</b><span>${t(k)}</span></div>`
    const act = (v, k, cls = '') => `<button class="btn ${cls}" data-act="driver-status" data-id="${d.id}" data-v="${v}">${t(k)}</button>`
    let btns = ''
    if (d.status === 'active') btns = act('suspended', 'suspend') + (isOwner() ? act('blocked', 'block', 'danger') : '')
    else if (d.status === 'suspended') btns = act('active', 'reactivate', 'ok') + (isOwner() ? act('blocked', 'block', 'danger') : '')
    else if (d.status === 'blocked' && isOwner()) btns = act('active', 'unblock')
    return `<div class="row"><h2><bdi>${esc(d.name)}</bdi></h2>${driverState(d)}</div>
      <div class="small muted"><span class="num">${esc(d.phone)}</span>${d.device_model ? ' · ' + esc(d.device_model) : ''}</div>
      <div class="stats" style="margin-top:12px">
        ${stat(d.reliability != null ? d.reliability + '%' : '—', 'stat_score')}
        ${stat(d.rating_avg != null ? Number(d.rating_avg).toFixed(1) + ' ★' : '—', 'stat_rating')}
        ${stat(d.completed_count, 'stat_done')}${stat(d.late_count, 'stat_late')}${stat(d.cancel_count, 'stat_cancel')}</div>
      <div class="btns"><a class="btn" href="tel:${esc(d.phone)}">${t('call')}</a>${btns}</div>
      <h3>${t('ratings_history')}</h3>
      <div class="card">${(m.ratings || []).length ? m.ratings.map((r) => `<div class="kv"><span>${'★'.repeat(r.stars)}${r.comment ? ' · ' + esc(r.comment) : ''}</span><span class="small muted num">${new Date(r.created_at).toLocaleDateString(locale())}</span></div>`).join('') : `<span class="muted">${m.ratings ? t('no_ratings') : '…'}</span>`}</div>
      <button class="btn block" data-act="close-modal" data-x="1">${t('close')}</button>`
  }

  // ---------------------------------------------------------------- après rendu
  // Carte du détail d'une commande : magasin, client et position du livreur.
  function orderMap() {
    const el = document.getElementById('omap')
    if (!el || !window.L) return
    const m = S.modal
    const o = S.data.orders.find((x) => x.id === m.id) || (S.hist.rows || []).find((x) => x.id === m.id)
    if (!o) return
    const s = S.data.settings, pts = []
    map = L.map(el, { zoomControl: false })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
    const dot = (lat, lng, color, label) => {
      pts.push([lat, lng])
      return L.circleMarker([lat, lng], { radius: 9, color, fillOpacity: 0.85 }).addTo(map).bindTooltip(label, { permanent: true, direction: 'top' })
    }
    if (s.shop_lat != null) dot(s.shop_lat, s.shop_lng, '#6b6468', t('map_shop'))
    if (o.lat != null) dot(o.lat, o.lng, '#b8245c', t('map_client'))
    const p = o.status === 'delivered' ? (o.delivered_lat != null ? { lat: o.delivered_lat, lng: o.delivered_lng } : null) : m.pos
    if (p) map._drv = dot(p.lat, p.lng, '#1c5fa8', t('driver'))
    if (pts.length > 1) map.fitBounds(pts, { padding: [34, 34], maxZoom: 16 })
    else if (pts.length) map.setView(pts[0], 15)
    else map.setView([31.8, -7.1], 6)
  }
  // Nouvelle position reçue pour la commande ouverte à l'écran.
  function onPosition(row) {
    const m = S.modal
    if (!row || !m || m.type !== 'order' || m.id !== row.order_id) return
    if (m.pos && m.pos.at === row.at) return
    const first = !m.pos
    m.pos = row
    if (first || !map || !map._drv || editing()) { if (!editing()) render(true) } else map._drv.setLatLng([row.lat, row.lng])
  }

  function setShopPos(loc, center) {
    if (!isOwner() || !map) return
    S.shopPos = loc
    map._pin = map._pin ? map._pin.setLatLng([loc.lat, loc.lng]) : L.circleMarker([loc.lat, loc.lng], { radius: 9, color: '#b8245c', fillOpacity: 0.8 }).addTo(map)
    if (center) map.setView([loc.lat, loc.lng], 17)
    toast(t('position_set'))
  }

  function afterRender() {
    if (S.modal?.type === 'order') orderMap()
    if (S.view === 'new' && S.session && !S.modal) {
      makeMap((loc) => setLocation(loc, false))
    } else if (S.view === 'settings' && !S.modal) {
      const s = S.data.settings
      makeMap(setShopPos, S.shopPos ? [S.shopPos.lat, S.shopPos.lng] : s.shop_lat != null ? [s.shop_lat, s.shop_lng] : null)
    }
    tickUi()
  }
  function tickUi() {
    const el = document.getElementById('qr-left')
    if (el && S.qr) {
      const left = Math.max(0, Math.floor((new Date(S.qr.expires_at) - Date.now()) / 1000))
      el.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : t('qr_expired')
      if (!left) { S.qr = null; render(true) }
    }
    // Filet de sécurité : relit la position du livreur toutes les 15 s tant que le détail est ouvert.
    if (S.modal?.type === 'order' && Date.now() - (tickUi.pos || 0) > 15000) {
      tickUi.pos = Date.now()
      const id = S.modal.id
      api.lastPosition(id).then((p) => { if (p && S.modal?.id === id) onPosition(p) }).catch(() => {})
    }
    // Rafraîchit les durées et les alertes de la liste.
    if (S.view === 'orders' && !S.modal && Date.now() - (tickUi.last || 0) > 10000) {
      tickUi.last = Date.now()
      const n = S.data.orders.filter(alertsOf).length
      if (n > lastAlertCount) beep()
      lastAlertCount = n
      render()
    }
  }

  async function openOrder(id, extra = {}) {
    S.modal = { type: 'order', id, ...extra }
    render(true)
    try {
      const [events, rating, pos] = await Promise.all([api.events(id), api.rating(id), api.lastPosition(id).catch(() => null)])
      if (S.modal?.id === id) {
        Object.assign(S.modal, { events, rating, pos })
        render(true)
      }
    } catch (e) {
      console.error(e)
    }
  }
  async function reloadModal() {
    await refresh()
    if (S.modal?.type === 'order') {
      S.modal.events = await api.events(S.modal.id).catch(() => S.modal.events)
    }
    render(true)
  }

  // ---------------------------------------------------------------- actions
  const act = {
    lang(d) {
      S.lang = d.v
      store.set('lang', S.lang)
      applyLang()
      render(true)
    },
    'login-mode'() {
      S.login = { mode: S.login.mode === 'in' ? 'up' : 'in', msg: '' }
      render(true)
    },
    async logout() {
      await api.signOut()
      location.reload()
    },
    nav(d) {
      S.view = d.v
      S.modal = null
      if (d.v === 'new') S.form = { loc: null }
      render(true)
      window.scrollTo(0, 0)
      if (d.v === 'history') loadHistory()
    },
    'open-order'(d) { openOrder(d.id) },
    async 'open-driver'(d) {
      S.modal = { type: 'driver', id: d.id }
      render(true)
      const ratings = await api.driverRatings(d.id).catch(() => [])
      if (S.modal?.id === d.id) { S.modal.ratings = ratings; render(true) }
    },
    'close-modal'(d, el, ev) {
      if (!d.x && ev.target !== el) return // clic à l'intérieur de la fenêtre
      if (S.modal?.raise || S.modal?.counter) { delete S.modal.raise; delete S.modal.counter; render(true); return }
      S.modal = null
      render(true)
    },
    raise(d) {
      if (S.modal?.type === 'order' && S.modal.id === d.id) { S.modal.raise = Number(d.n); render(true) }
      else openOrder(d.id, { raise: Number(d.n) })
    },
    async 'raise-do'(d) {
      const { id, raise } = S.modal
      if (await run(() => api.rpc('staff_raise', { p_order: id, p_amount: raise, p_payer: d.v }))) {
        delete S.modal.raise
        await reloadModal()
      }
    },
    async ring(d) {
      if (await run(() => api.rpc('staff_broadcast', { p_order: d.id }), t('ev_ring_again'))) await reloadModal()
    },
    async pay(d) {
      if (await run(() => api.rpc('staff_confirm_payment', { p_order: d.id }), t('payment_ok'))) await reloadModal()
    },
    async reassign(d) {
      if (!confirm(t('reassign_confirm'))) return
      if (await run(() => api.rpc('staff_reassign', { p_order: d.id }), t('ev_reassigned'))) await reloadModal()
    },
    async cancel(d) {
      if (!confirm(t('cancel_confirm'))) return
      if (await run(() => api.rpc('staff_cancel', { p_order: d.id }), t('st_cancelled'))) { S.modal = null; await refresh(); render(true) }
    },
    star(d) {
      S.modal.comment = document.getElementById('r-comment')?.value
      S.modal.stars = Number(d.n)
      render(true)
    },
    async rate(d) {
      const comment = document.getElementById('r-comment')?.value || ''
      const stars = S.modal.stars ?? S.modal.rating?.stars
      if (await run(() => api.rpc('staff_rate', { p_order: d.id, p_stars: stars, p_comment: comment }), t('saved'))) { S.modal = null; await refresh(); render(true) }
    },
    async 'driver-status'(d) {
      if (await run(() => api.rpc('staff_set_driver_status', { p_driver: d.id, p_status: d.v }))) { await refresh(); render(true) }
    },
    async 'staff-role'(d) {
      if (await run(() => api.rpc('owner_set_staff_role', { p_user: d.id, p_role: d.v }))) { await refresh(); render(true) }
    },
    'counter-accept'(d) {
      if (S.modal?.type === 'order' && S.modal.id === d.id) { S.modal.counter = d.c; render(true) }
      else openOrder(d.id, { counter: d.c })
    },
    async 'counter-refuse'(d) {
      if (await run(() => api.rpc('staff_counter_refuse', { p_id: d.c }), t('ev_counter_refused'))) await reloadModal()
    },
    async 'counter-do'(d) {
      const id = S.modal.counter
      if (await run(() => api.rpc('staff_counter_apply', { p_id: id, p_payer: d.v }), t('ev_ring_again'))) { delete S.modal.counter; await reloadModal() }
    },
    async 'counter-toggle'(d) {
      if (await run(() => api.rpc('staff_set_counter', { p_order: d.id, p_allowed: !!d.v }), t('saved'))) await reloadModal()
    },
    async 'track-copy'(d) {
      const o = S.data.orders.find((x) => x.id === d.id)
      if (!o) return
      try { await navigator.clipboard.writeText(trackUrl(o)); toast(t('copied')) } catch { prompt('', trackUrl(o)) }
    },
    'my-position'() {
      if (!navigator.geolocation) return toast(t('position_denied'))
      navigator.geolocation.getCurrentPosition(
        (p) => setShopPos({ lat: p.coords.latitude, lng: p.coords.longitude }, true),
        () => toast(t('position_denied')),
        { enableHighAccuracy: true, timeout: 15000 }
      )
    },
    'qr-reset'() { S.qr = null; render(true) },
    async 'qr-new'() {
      await run(async () => { S.qr = await api.rpc('staff_new_token') })
      render(true)
    },
  }

  const forms = {
    async login(form) {
      const f = new FormData(form)
      const email = f.get('email').trim(), password = f.get('password')
      if (S.login.mode === 'up') {
        const ok = await run(async () => {
          const r = await api.signUp(email, password)
          if (r?.session) await api.rpc('claim_staff', { p_name: f.get('name').trim() })
          else store.set('pending_name', f.get('name').trim())
        })
        if (!ok) return
        if (await api.session()) return location.reload()
        S.login = { mode: 'in', msg: t('signup_done') }
        render(true)
      } else if (await run(async () => {
        await api.signIn(email, password)
        await api.rpc('claim_staff', { p_name: store.get('pending_name') })
      })) location.reload()
    },
    async order(form) {
      const p = readOrderForm(form)
      if (!p.customer_name) return toast(t('err_name_required'))
      if (!/^\+212[5-7]\d{8}$/.test(p.customer_phone)) return toast(t('err_bad_phone'))
      if (p.amount === null) return toast(t('err_amount_required'))
      if (p.lat === null && !p.maps_url) return toast(t('f_location_missing'))
      if (await run(() => api.rpc('staff_create_order', { p, p_broadcast: true }), t('ev_broadcast'))) {
        S.view = 'orders'
        S.form = null
        await refresh()
        render(true)
        window.scrollTo(0, 0)
      }
    },
    async settings(form) {
      const f = new FormData(form)
      const p = {
        shop_name: f.get('shop_name'), no_accept_alert_seconds: Number(f.get('no_accept_alert_seconds')),
        late_tolerance_minutes: Number(f.get('late_tolerance_minutes')), priority_seconds: Number(f.get('priority_seconds')),
        counter_enabled: f.get('counter_enabled') === 'on', counter_delay_seconds: Number(f.get('counter_delay_min') || 5) * 60,
        shop_lat: S.shopPos?.lat ?? null, shop_lng: S.shopPos?.lng ?? null,
      }
      if (await run(() => api.rpc('owner_update_settings', { p }), t('saved'))) { document.activeElement?.blur(); await refresh(); render(true) }
    },
    async qr(form) {
      const f = new FormData(form)
      const name = f.get('name').trim(), phone = normPhone(f.get('phone'))
      if (!name) return toast(t('err_name_required'))
      if (!/^\+212[5-7]\d{8}$/.test(phone)) return toast(t('err_bad_phone'))
      if (await run(async () => { S.qr = { ...(await api.rpc('staff_new_token', { p_name: name, p_phone: phone })), name, phone } })) {
        document.activeElement?.blur()
        render(true)
      }
    },
    async password(form) {
      const pw = new FormData(form).get('password')
      if (await run(() => api.setPassword(pw), t('saved'))) form.reset()
    },
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]')
    if (!el || !act[el.dataset.act]) return
    if (el.tagName === 'BUTTON') ev.preventDefault()
    act[el.dataset.act](el.dataset, el, ev)
  })
  document.addEventListener('submit', (ev) => {
    const name = ev.target.dataset.form
    if (!forms[name]) return
    ev.preventDefault()
    forms[name](ev.target)
  })
  document.addEventListener('change', (ev) => {
    const k = ev.target.dataset.change
    if (k === 'lang') act.lang({ v: ev.target.value })
    if (k === 'hist-day' && ev.target.value) { S.hist.day = ev.target.value; ev.target.blur(); loadHistory() }
  })
  document.addEventListener('input', (ev) => {
    const form = ev.target.closest('[data-form="order"]')
    if (!form) return
    if (ev.target.name === 'location') setLocation(parseLocation(ev.target.value), true)
    else document.getElementById('summary').innerHTML = moneySummary(readOrderForm(form))
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.modal) { S.modal = null; render(true) }
  })

  start()
})()
