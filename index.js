const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Twilio ───────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// ─── Firebase Admin ───────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: 'https://il-nonno-espera-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ─── Mensajes SMS ─────────────────────────────────────────
function smsText(type, name, pos) {
  const n = name.split(' ')[0];
  const msgs = {
    m1: `¡Benvenuto a IL NONNO! Hola ${n}, estás en la lista como grupo #${pos}. Te contactaremos en cada paso: cuando seas el próximo, cuando la mesa esté lista y cuando debas acercarte. ¡Mantén el celular a la mano!`,
    m2: `¡Casi es tu momento, ${n}! En IL NONNO te estamos preparando el espacio. Serán los próximos en ser acomodados — por favor permanezcan cerca de la entrada.`,
    m3: `${n}, su mesa está en preparación. Acérquense a la entrada, nuestro anfitrión los está esperando. ¡Un momento más!`,
    m4: `${n}, su mesa está lista. Acérquense a la entrada ahora. ¡Bienvenidos a IL NONNO!`,
    m4b: `${n}, los llamamos pero no los encontramos. Su lugar fue cedido al siguiente grupo. Si aún están cerca, respondan VOLVER y los reincorporamos al final de la lista.`,
    incomplete: `${n}, notamos que su grupo no está completo aún. En IL NONNO la fila es para grupos listos para ingresar. Estamos dejando pasar al siguiente grupo mientras se completan. Avisen al anfitrión cuando estén todos para asignarles mesa. ¡Los esperamos!`,
    reactivated: `¡Buenas noticias, ${n}! Su grupo ha sido reactivado en la lista. En cuanto sea su turno les avisamos. ¡Gracias por su paciencia!`,
    prog5: `${n}, hay 5 grupos antes que el tuyo. Mantén el celular a la mano, tu turno se acerca.`,
    prog3: `${n}, ya están cerca — solo 3 grupos antes que ustedes. Por favor permanezcan cerca de la entrada.`,
    prog2: `${n}, son el 2° grupo en la lista. ¡Prepárense, casi es su momento!`,
  };
  return msgs[type] || '';
}

// ─── Enviar SMS ───────────────────────────────────────────
async function sendSMS(to, body) {
  const phone = to.startsWith('+') ? to : `+57${to}`;
  return twilioClient.messages.create({ body, from: TWILIO_NUMBER, to: phone });
}

// ─── RUTAS ────────────────────────────────────────────────

app.get('/', (req, res) => res.send('IL NONNO servidor activo ✓'));

// ─── Panel anfitrión ──────────────────────────────────────
const path = require('path');
app.get('/anfitrion', (req, res) => {
  res.sendFile(path.join(__dirname, 'anfitrion.html'));
});

// Registrar cliente
app.post('/register', async (req, res) => {
  try {
    const { name, phone, persons } = req.body;
    const ref = db.ref('queue');
    const snapshot = await ref.once('value');
    const existing = snapshot.val() || {};

    // Verificar si el número ya tiene un registro activo
    const activeStatuses = ['wait', 'soon', 'ready', 'incomplete'];
    const duplicate = Object.values(existing).find(
      item => item.phone === phone && activeStatuses.includes(item.status)
    );
    if (duplicate) {
      return res.json({ ok: false, duplicate: true });
    }

    const pos = Object.keys(existing).length + 1;
    const newEntry = {
      name, phone, persons,
      status: 'wait',
      time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      createdAt: Date.now(),
      m2at: null, m3at: null, incompleteAt: null, skippedBy: 0
    };
    const newRef = await ref.push(newEntry);
    await sendSMS(phone, smsText('m1', name, pos));
    res.json({ ok: true, id: newRef.key, pos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Notificar estado
app.post('/notify', async (req, res) => {
  try {
    const { id, type } = req.body;
    const ref = db.ref(`queue/${id}`);
    const snap = await ref.once('value');
    const item = snap.val();
    if (!item) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    const allSnap = await db.ref('queue').once('value');
    const all = allSnap.val() || {};
    const active = Object.values(all).filter(q => q.status !== 'seated' && q.status !== 'absent' && q.status !== 'incomplete');
    const pos = active.findIndex(q => q.name === item.name) + 1;
    const updates = {};
    if (type === 'm2') { updates.status = 'soon'; updates.m2at = Date.now(); }
    else if (type === 'm3') { updates.status = 'ready'; updates.m3at = Date.now(); }
    else if (type === 'm4') { updates.status = 'seated'; }
    else if (type === 'm4b') { updates.status = 'absent'; }
    else if (type === 'incomplete') { updates.status = 'incomplete'; updates.incompleteAt = Date.now(); }
    else if (type === 'reactivated') { updates.status = 'wait'; updates.incompleteAt = null; updates.m2at = null; updates.m3at = null; }
    await ref.update(updates);
    await sendSMS(item.phone, smsText(type, item.name, pos));
    if (type === 'm4') await checkProgressSMS(all, id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Editar registro
app.post('/edit', async (req, res) => {
  try {
    const { id, name, phone, persons } = req.body;
    await db.ref(`queue/${id}`).update({ name, phone, persons });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reincorporar
app.post('/reincorporate', async (req, res) => {
  try {
    const { id } = req.body;
    const snap = await db.ref(`queue/${id}`).once('value');
    const item = snap.val();
    await db.ref(`queue/${id}`).update({
      status: 'wait', m2at: null, m3at: null, incompleteAt: null,
      time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      createdAt: Date.now()
    });
    await sendSMS(item.phone, smsText('reactivated', item.name, 0));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Eliminar
app.post('/remove', async (req, res) => {
  try {
    const { id } = req.body;
    await db.ref(`queue/${id}`).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SMS de progreso automático
async function checkProgressSMS(all, seatedId) {
  const active = Object.entries(all)
    .filter(([k, v]) => k !== seatedId && v.status !== 'seated' && v.status !== 'absent' && v.status !== 'incomplete')
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < active.length; i++) {
    const [key, item] = active[i];
    const pos = i + 1;
    for (const t of [{ pos: 5, key: 'prog5' }, { pos: 3, key: 'prog3' }, { pos: 2, key: 'prog2' }]) {
      if (pos === t.pos && !item['sent_' + t.key]) {
        await db.ref(`queue/${key}`).update({ ['sent_' + t.key]: true });
        await sendSMS(item.phone, smsText(t.key, item.name, pos));
      }
    }
  }
}

// Webhook VOLVER
app.post('/sms-reply', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim().toUpperCase();
  if (body === 'VOLVER') {
    const snap = await db.ref('queue').orderByChild('phone').equalTo(from.replace('+57', '')).once('value');
    const val = snap.val();
    if (val) {
      const [id, item] = Object.entries(val)[0];
      await db.ref(`queue/${id}`).update({ status: 'absent' });
      await sendSMS(item.phone, `Hola ${item.name.split(' ')[0]}, recibimos tu mensaje. El anfitrión revisará tu caso y te reincorporará a la lista. ¡Gracias!`);
    }
  }
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IL NONNO servidor corriendo en puerto ${PORT}`));
