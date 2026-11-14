// Accès aux données : Supabase en vrai, ou données fictives avec ?demo dans l'adresse.
;(function () {
  const cfg = window.APP_CONFIG || {}
  const isDemo = new URLSearchParams(location.search).has('demo')
  const ACTIVE = ['created', 'broadcast', 'accepted', 'at_shop', 'picked_up']

  function dayRange(dateStr) {
    const start = dateStr ? new Date(dateStr + 'T00:00:00') : new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return [start, end]
  }

  function supabaseApi() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    const chk = ({ data, error }) => {
      if (error) throw error
      return data
    }
    return {
      demo: false,
      async session() {
        return chk(await sb.auth.getSession()).session
      },
      async signIn(email, password) {
        chk(await sb.auth.signInWithPassword({ email, password }))
      },
      async signUp(email, password) {
        return chk(await sb.auth.signUp({ email, password }))
      },
      async signOut() {
        await sb.auth.signOut()
      },
      async setPassword(password) {
        chk(await sb.auth.updateUser({ password }))
      },
      async rpc(name, args) {
        return chk(await sb.rpc(name, args))
      },
      async load() {
        const [start] = dayRange()
        const [settings, orders, drivers, staff, counters] = await Promise.all([
          sb.from('settings').select('*').eq('id', 1).single(),
          sb.from('orders').select('*')
            .or(`created_at.gte.${start.toISOString()},status.in.(${ACTIVE.join(',')})`)
            .order('created_at', { ascending: false }),
          sb.from('drivers').select('*').order('created_at'),
          sb.from('staff').select('*').order('created_at'),
          sb.from('counter_offers').select('*').eq('status', 'pending').order('created_at'),
        ])
        // Les contre-offres n'existent qu'après la mise à jour de la base : on tolère leur absence.
        return { settings: chk(settings), orders: chk(orders), drivers: chk(drivers), staff: chk(staff), counters: counters.error ? [] : counters.data }
      },
      async events(orderId) {
        return chk(await sb.from('order_events').select('*').eq('order_id', orderId).order('id'))
      },
      async rating(orderId) {
        return chk(await sb.from('ratings').select('*').eq('order_id', orderId).maybeSingle())
      },
      async lastPosition(orderId) {
        return chk(await sb.from('positions').select('*').eq('order_id', orderId).order('at', { ascending: false }).limit(1).maybeSingle())
      },
      async driverRatings(driverId) {
        return chk(await sb.from('ratings').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(50))
      },
      async ordersByDay(dateStr) {
        const [start, end] = dayRange(dateStr)
        return chk(await sb.from('orders').select('*')
          .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
          .order('created_at', { ascending: false }))
      },
      subscribe(cb) {
        sb.channel('dashboard').on('postgres_changes', { event: '*', schema: 'public' }, cb).subscribe()
      },
    }
  }

  // ------------------------------------------------------------------
  // Mode démonstration : mêmes règles que la base, en mémoire.
  // ------------------------------------------------------------------
  function demoApi() {
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
    const id = () => 'x' + Math.random().toString(36).slice(2, 10)
    const db = {
      settings: { id: 1, shop_name: 'Hubert et Pessina', shop_lat: 33.5731, shop_lng: -7.5898, priority_seconds: 30, no_accept_alert_seconds: 180, late_tolerance_minutes: 5 },
      staff: [
        { user_id: 'me', role: 'owner', name: 'Gérant', email: 'gerant@exemple.ma' },
        { user_id: 's2', role: 'pending', name: 'Téléphone du magasin', email: 'magasin@exemple.ma' },
      ],
      drivers: [
        { id: 'd1', name: 'Youssef B.', phone: '+212611111111', status: 'active', online: true, rating_avg: 4.8, rating_count: 12, completed_count: 34, late_count: 1, cancel_count: 0, reliability: 96, device_model: 'Xiaomi Redmi 12' },
        { id: 'd2', name: 'Karim A.', phone: '+212622222222', status: 'active', online: true, rating_avg: 4.1, rating_count: 5, completed_count: 9, late_count: 2, cancel_count: 1, reliability: 71, device_model: 'Oppo A17' },
        { id: 'd3', name: 'Hamza E.', phone: '+212633333333', status: 'active', online: false, rating_avg: null, rating_count: 0, completed_count: 0, late_count: 0, cancel_count: 0, reliability: null, device_model: 'Infinix Hot 30' },
        { id: 'd4', name: 'Omar T.', phone: '+212644444444', status: 'pending', online: false, rating_count: 0, completed_count: 0, late_count: 0, cancel_count: 0, device_model: 'Tecno Spark 10' },
      ],
      orders: [],
      events: [],
      counters: [],
      ratings: [{ id: 'r1', order_id: 'old', driver_id: 'd1', stars: 5, comment: 'Rapide et poli', created_at: ago(1500) }],
      n: 40,
    }
    const calc = (o) => {
      const base = o.prepaid ? 0 : Number(o.amount)
      o.pay_at_shop = base - Number(o.shop_bonus)
      o.collect_from_customer = base + Number(o.delivery_fee)
      o.driver_gain = Number(o.delivery_fee) + Number(o.shop_bonus)
      return o
    }
    const log = (order_id, event, data = {}, at) => db.events.push({ id: db.events.length + 1, order_id, event, data, at: at || new Date().toISOString() })
    const add = (o, evs) => {
      const row = calc({ id: id(), track_token: 'demo' + id() + id(), number: ++db.n, shop_bonus: 0, prepaid: false, ring_seq: 1, created_at: ago(o.age), ...o })
      db.orders.unshift(row)
      evs.forEach(([e, m, d]) => log(row.id, e, d, ago(m)))
      return row
    }
    const o41 = add({ age: 6, external_ref: '820D-38', customer_name: 'Rajaa H.', customer_phone: '+212701209958', area: 'Maârif', lat: 33.58, lng: -7.63, amount: 22.5, delivery_fee: 15, status: 'broadcast', broadcast_at: ago(6), last_ring_at: ago(6) },
      [['created', 6], ['broadcast', 6]])
    db.counters.push({ id: 'c1', order_id: o41.id, driver_id: 'd2', gain: 25, status: 'pending' })
    add({ age: 14, customer_name: 'Salma K.', customer_phone: '+212655555555', area: 'Gauthier', address_text: '2e étage, porte bleue', lat: 33.59, lng: -7.62, amount: 180, delivery_fee: 20, status: 'accepted', driver_id: 'd2', eta_minutes: 5, accepted_at: ago(12), eta_at: ago(7) },
      [['created', 14], ['broadcast', 14], ['accepted', 12, { eta: 5 }]])
    add({ age: 20, customer_name: 'Mehdi O.', customer_phone: '+212666666666', area: 'Bourgogne', lat: 33.6, lng: -7.64, amount: 340, delivery_fee: 0, shop_bonus: 25, status: 'at_shop', driver_id: 'd1', eta_minutes: 10, accepted_at: ago(15), eta_at: ago(5), arrived_at: ago(6) },
      [['created', 20], ['broadcast', 20], ['accepted', 15, { eta: 10 }], ['at_shop', 6]])
    add({ age: 95, customer_name: 'Nadia F.', customer_phone: '+212677777777', area: 'Racine', lat: 33.59, lng: -7.64, amount: 95, delivery_fee: 15, status: 'delivered', driver_id: 'd1', payment_confirmed_at: ago(70), delivered_at: ago(50) },
      [['created', 95], ['broadcast', 95], ['accepted', 90, { eta: 10 }], ['at_shop', 72], ['payment_confirmed', 70], ['picked_up', 69], ['delivered', 50]])

    let listeners = []
    const changed = () => setTimeout(() => listeners.forEach((f) => f()), 0)
    const order = (i) => {
      const o = db.orders.find((x) => x.id === i)
      if (!o) throw new Error('not_found')
      return o
    }
    const need = (o, ...st) => {
      if (!st.includes(o.status)) throw new Error('bad_status')
    }
    const release = (o) => Object.assign(o, { status: 'broadcast', driver_id: null, eta_minutes: null, accepted_at: null, eta_at: null, arrived_at: null, payment_confirmed_at: null, ring_seq: o.ring_seq + 1, last_ring_at: new Date().toISOString() })
    const now = () => new Date().toISOString()

    const fn = {
      claim_staff: () => 'owner',
      staff_tick: () => null,
      owner_update_settings: ({ p }) => {
        for (const k in p) if (p[k] !== null && p[k] !== '') db.settings[k] = p[k]
      },
      owner_set_staff_role: ({ p_user, p_role }) => {
        if (p_role === 'remove') db.staff = db.staff.filter((s) => s.user_id !== p_user)
        else db.staff.find((s) => s.user_id === p_user).role = p_role
      },
      staff_new_token: ({ p_phone } = {}) => {
        if (p_phone && !/^\+212[5-7][0-9]{8}$/.test(p_phone)) throw new Error('bad_phone')
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        let token = ''
        for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)]
        return { token, expires_at: new Date(Date.now() + 600000).toISOString() }
      },
      staff_set_driver_status: ({ p_driver, p_status }) => {
        const d = db.drivers.find((x) => x.id === p_driver)
        d.status = p_status
        if (p_status !== 'active') {
          d.online = false
          db.orders.filter((o) => o.driver_id === d.id && ['accepted', 'at_shop'].includes(o.status)).forEach((o) => {
            release(o)
            log(o.id, 'reassigned')
          })
        }
      },
      staff_create_order: ({ p, p_broadcast }) => {
        if (!String(p.customer_name || '').trim()) throw new Error('name_required')
        if (!/^\+212[5-7][0-9]{8}$/.test(p.customer_phone || '')) throw new Error('bad_phone')
        if (p.amount === null || p.amount === undefined) throw new Error('amount_required')
        const o = calc({ id: id(), track_token: 'demo' + id() + id(), number: ++db.n, ring_seq: 0, created_at: now(), status: 'created', delivery_fee: 0, shop_bonus: 0, prepaid: false, ...p })
        db.orders.unshift(o)
        log(o.id, 'created')
        if (p_broadcast) fn.staff_broadcast({ p_order: o.id })
        return o.id
      },
      staff_broadcast: ({ p_order }) => {
        const o = order(p_order)
        need(o, 'created', 'broadcast')
        log(o.id, o.status === 'created' ? 'broadcast' : 'ring_again')
        Object.assign(o, { status: 'broadcast', broadcast_at: o.broadcast_at || now(), last_ring_at: now(), ring_seq: o.ring_seq + 1 })
      },
      staff_raise: ({ p_order, p_amount, p_payer }) => {
        const o = order(p_order)
        need(o, 'created', 'broadcast')
        if (p_payer === 'client') o.delivery_fee = Number(o.delivery_fee) + p_amount
        else o.shop_bonus = Number(o.shop_bonus) + p_amount
        Object.assign(calc(o), { ring_seq: o.ring_seq + 1, last_ring_at: now() })
        log(o.id, 'raised', { amount: p_amount, payer: p_payer })
      },
      staff_confirm_payment: ({ p_order }) => {
        const o = order(p_order)
        need(o, 'accepted', 'at_shop')
        if (o.status === 'accepted') {
          Object.assign(o, { status: 'at_shop', arrived_at: now() })
          log(o.id, 'at_shop')
        }
        o.payment_confirmed_at = now()
        log(o.id, 'payment_confirmed')
      },
      staff_reassign: ({ p_order }) => {
        const o = order(p_order)
        need(o, 'accepted', 'at_shop')
        release(o)
        log(o.id, 'reassigned')
      },
      staff_cancel: ({ p_order }) => {
        const o = order(p_order)
        if (['delivered', 'cancelled'].includes(o.status)) throw new Error('bad_status')
        Object.assign(o, { status: 'cancelled', cancelled_at: now() })
        log(o.id, 'cancelled')
      },
      staff_set_counter: ({ p_order, p_allowed }) => {
        order(p_order).counter_allowed = p_allowed
        log(p_order, 'counter_setting')
      },
      staff_counter_refuse: ({ p_id }) => {
        const c = db.counters.find((x) => x.id === p_id)
        c.status = 'refused'
        log(c.order_id, 'counter_refused')
      },
      staff_counter_apply: ({ p_id, p_payer }) => {
        const c = db.counters.find((x) => x.id === p_id)
        const o = order(c.order_id)
        const diff = c.gain - o.driver_gain
        if (p_payer === 'client') o.delivery_fee = Number(o.delivery_fee) + diff
        else o.shop_bonus = Number(o.shop_bonus) + diff
        Object.assign(calc(o), { ring_seq: o.ring_seq + 1, last_ring_at: now() })
        c.status = 'applied'
        log(o.id, 'counter_applied', { amount: diff, payer: p_payer })
      },
      owner_delete_order: ({ p_order }) => {
        db.orders = db.orders.filter((o) => o.id !== p_order)
      },
      staff_rate: ({ p_order, p_stars, p_comment }) => {
        const o = order(p_order)
        need(o, 'delivered')
        db.ratings = db.ratings.filter((r) => r.order_id !== o.id)
        db.ratings.unshift({ id: id(), order_id: o.id, driver_id: o.driver_id, stars: p_stars, comment: p_comment, created_at: now() })
        const mine = db.ratings.filter((r) => r.driver_id === o.driver_id)
        const d = db.drivers.find((x) => x.id === o.driver_id)
        d.rating_count = mine.length
        d.rating_avg = mine.reduce((a, r) => a + r.stars, 0) / mine.length
        log(o.id, 'rated', { stars: p_stars })
      },
    }
    const copy = (x) => JSON.parse(JSON.stringify(x))
    return {
      demo: true,
      async session() {
        return { user: { id: 'me', email: 'gerant@exemple.ma' } }
      },
      async signIn() {},
      async signUp() {},
      async signOut() {},
      async setPassword() {},
      async rpc(name, args) {
        const r = fn[name](args || {})
        changed()
        return r
      },
      async load() {
        return copy({ settings: db.settings, orders: db.orders, drivers: db.drivers, staff: db.staff, counters: db.counters.filter((c) => c.status === 'pending') })
      },
      async events(orderId) {
        return copy(db.events.filter((e) => e.order_id === orderId).sort((a, b) => a.at.localeCompare(b.at)))
      },
      async rating(orderId) {
        return copy(db.ratings.find((r) => r.order_id === orderId) || null)
      },
      async lastPosition(orderId) {
        const o = db.orders.find((x) => x.id === orderId)
        if (!o || !o.driver_id || o.status === 'delivered') return null
        return { order_id: orderId, lat: 33.577 + Math.random() * 0.004, lng: -7.61 - Math.random() * 0.004, at: new Date().toISOString() }
      },
      async driverRatings(driverId) {
        return copy(db.ratings.filter((r) => r.driver_id === driverId))
      },
      async ordersByDay(dateStr) {
        const [start, end] = dayRange(dateStr)
        return copy(db.orders.filter((o) => new Date(o.created_at) >= start && new Date(o.created_at) < end))
      },
      subscribe(cb) {
        listeners.push(cb)
      },
    }
  }

  window.API = isDemo ? demoApi() : cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY ? supabaseApi() : null
})()
