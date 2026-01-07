const KEEP_ALIVE_INTERVAL = 30000; // 30 detik

// Tambahkan ini setelah route health check
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    whatsapp: currentStatus
  });
});

// Auto-ping untuk menjaga service tetap hidup
setInterval(() => {
  if (currentStatus === 'ready') {
    console.log('❤️  Bot is alive and responding');
  }
}, KEEP_ALIVE_INTERVAL);
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ======= Whatsapp client setup =======
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-features=site-per-process'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

// helper delay
const delay = ms => new Promise(res => setTimeout(res, ms));

// load media (sesuaikan path dokumen kamu)
const loadMedia = filename => {
  try { 
    const filePath = path.join(__dirname, 'dokumen', filename);
    if (fs.existsSync(filePath)) {
      return MessageMedia.fromFilePath(filePath);
    }
    console.warn('File not found:', filePath);
    return null;
  } catch (e) { 
    console.warn('Error loading media:', filename, e.message);
    return null; 
  }
};

// Load semua media
const fotoSalam = loadMedia('lpk2.png');
const fotoreguler = loadMedia('lpk.png');
const fotoonline = loadMedia('lpk3.png');
const fotoregister = loadMedia('lpk4.png');
const fotosyarat = loadMedia('lpk7.png');
const dokumenbiaya = loadMedia('RINCIAN BIAYA PENDIDIKAN LPK MITSU GAKUEN.pdf');
const dokumendetail = loadMedia('detail lpk mitsu.pdf');

// keywords
const keywords = {
  kelas: ['kelas', 'kelasnya', 'class'],
  informasi: ['informasi', 'info', 'tentang', 'detail'],
  salam: ['hai', 'halo', 'hallo', 'assalamualaikum', 'permisi'],
  reguler: ['kelas reguler', 'reguler', 'offline', 'tatap muka'],
  online: ['kelas online', 'online', 'kelas daring', 'zoom', 'onlen'],
  syarat: ['syarat', 'persyaratan', 'ketentuan', 'dokumen'],
  register: ['register', 'daftar', 'registrasi', 'regis', 'join', 'gabung', 'pendaftaran'],
  lokasi: ['lokasi', 'alamat', 'maps', 'tempat'],
  sosmed: ['media sosial', 'sosmed', 'instagram', 'ig', 'tiktok', 'medsos'],
  biaya: ['biaya', 'harga', 'cost', 'bayar', 'berapa']
};

const containsKeyword = (text, arr) => arr.some(k => text.toLowerCase().includes(k));

// per-user state for onboarding
const users = new Map();

// silent mode (temporary hold auto-reply)
const silentUsers = new Map();

function setSilent(userId) {
  silentUsers.set(userId, Date.now());
  setTimeout(async () => {
    silentUsers.delete(userId);
    try {
      await client.sendMessage(userId, 'Terimakasih sudah menghubungi kami 😊 Apakah Hana bisa bantu lagi?');
    } catch (e) { 
      console.error('sendMessage after silent timeout failed', e); 
    }
  }, 5 * 60 * 1000);
}

// server snapshot state
let currentStatus = 'server_ready';
let lastQr = null;
let lastEvent = null;
let lastMessagesBuffer = [];

// contacts and messages store (in-memory)
const contacts = new Map(); // id -> { id, name, active:true, unread:0, lastMsg }
const messagesByContact = new Map(); // id -> [{ from, body, ts }]

function ensureContact(id, name) {
  if (!contacts.has(id)) {
    contacts.set(id, { 
      id, 
      name: name || id.replace('@c.us',''), 
      active: true, 
      unread: 0, 
      lastMsg: '' 
    });
  } else if (name) {
    const c = contacts.get(id);
    c.name = name;
    contacts.set(id, c);
  }
  if (!messagesByContact.has(id)) messagesByContact.set(id, []);
}

function emitContactsToAll() {
  const arr = Array.from(contacts.values()).map(c => ({
    id: c.id, 
    name: c.name, 
    active: c.active, 
    unread: c.unread, 
    lastMsg: c.lastMsg
  }));
  
  // sort by last message timestamp
  arr.sort((a,b) => {
    const ma = messagesByContact.get(a.id) || []; 
    const mb = messagesByContact.get(b.id) || [];
    const ta = ma.length ? (ma[ma.length-1].ts || 0) : 0;
    const tb = mb.length ? (mb[mb.length-1].ts || 0) : 0;
    return tb - ta;
  });
  
  io.emit('contacts', arr);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    whatsapp: currentStatus,
    timestamp: new Date().toISOString(),
    contacts: contacts.size,
    messages: lastMessagesBuffer.length
  });
});

// Socket connection
io.on('connection', socket => {
  console.log('Frontend connected to socket.io');

  // send snapshot
  socket.emit('status', currentStatus);
  if (lastQr) socket.emit('qr', lastQr);
  if (lastEvent) socket.emit('lastEvent', lastEvent);
  if (client.info) socket.emit('session_info', client.info);

  // buffered messages (light)
  lastMessagesBuffer.slice(-100).forEach(m => socket.emit('message', m));

  // send current contacts
  emitContactsToAll();

  // handle frontend requests
  socket.on('get_messages', async contactId => {
    try {
      let msgs = messagesByContact.get(contactId) || [];
      
      // if empty, attempt fetch from WA chat
      if (!msgs.length) {
        try {
          const chat = await client.getChatById(contactId);
          const fetched = await chat.fetchMessages({ limit: 200 });
          msgs = fetched.reverse().map(m => ({ 
            from: m.from, 
            body: m.body || '', 
            ts: m.timestamp || Date.now() 
          }));
          messagesByContact.set(contactId, msgs);
          
          // update contact lastMsg if exists
          if (msgs.length) {
            const c = contacts.get(contactId) || {};
            c.lastMsg = msgs[msgs.length-1].body || '';
            contacts.set(contactId, c);
            emitContactsToAll();
          }
        } catch (e) {
          console.warn('fetch messages failed for', contactId, e && e.message);
        }
      }
      
      socket.emit('messages_for', { id: contactId, messages: msgs });
      
      // mark unread = 0
      if (contacts.has(contactId)) {
        const c = contacts.get(contactId);
        c.unread = 0;
        contacts.set(contactId, c);
        emitContactsToAll();
      }
    } catch (err) {
      console.error('get_messages error', err);
    }
  });

  socket.on('toggle_contact', ({ id, active }) => {
    if (!contacts.has(id)) return;
    const c = contacts.get(id);
    c.active = !!active;
    contacts.set(id, c);
    emitContactsToAll();
    socket.emit('toggled', { id, active: c.active });
  });
});

// WhatsApp events
client.on('qr', qr => {
  console.log('QR RECEIVED');
  qrcode.toDataURL(qr).then(url => {
    lastQr = url; 
    currentStatus = 'qr'; 
    lastEvent = 'qr';
    io.emit('qr', url); 
    io.emit('status', 'qr'); 
    console.log('QR sent to frontend');
  }).catch(e => console.error('QR generation error:', e));
});

client.on('authenticated', () => {
  console.log('AUTHENTICATED');
  currentStatus = 'authenticated'; 
  lastEvent = 'authenticated';
  io.emit('status', 'authenticated'); 
  io.emit('lastEvent', lastEvent);
});

client.on('ready', async () => {
  console.log('WHATSAPP READY');
  currentStatus = 'ready'; 
  lastEvent = 'ready';
  io.emit('status', 'ready'); 
  io.emit('lastEvent', lastEvent);
  
  if (client.info) {
    io.emit('session_info', client.info);
  }

  // populate contacts & recent messages
  try {
    const chats = await client.getChats();
    console.log(`Found ${chats.length} chats`);
    
    for (const chat of chats.slice(0, 50)) { // Limit untuk menghindari timeout
      try {
        const id = chat.id._serialized;
        const name = (chat.contact && (chat.contact.pushname || chat.contact.number)) || chat.name || id;
        ensureContact(id, name);

        const fetched = await chat.fetchMessages({ limit: 20 });
        const mapped = fetched.reverse().map(m => ({ 
          from: m.from, 
          body: m.body || '', 
          ts: m.timestamp || Date.now() 
        }));
        
        const arr = (messagesByContact.get(id) || []).concat(mapped);
        messagesByContact.set(id, arr.slice(-200));
        
        if (mapped.length) {
          const c = contacts.get(id);
          c.lastMsg = mapped[mapped.length-1].body || '';
          contacts.set(id, c);
        }
      } catch (e) { 
        console.warn('Error processing chat:', e.message);
      }
    }
    
    emitContactsToAll();
  } catch (err) {
    console.error('ready: fetch chats error', err && err.message);
  }
});

client.on('auth_failure', msg => {
  console.log('AUTH FAILURE:', msg);
  currentStatus = 'auth_failure'; 
  lastEvent = 'auth_failure';
  io.emit('status', 'auth_failure:' + msg);
});

client.on('disconnected', reason => {
  console.log('DISCONNECTED:', reason);
  currentStatus = 'disconnected'; 
  lastEvent = 'disconnected';
  io.emit('status', 'disconnected');
  
  // Restart client after 10 seconds
  setTimeout(() => {
    console.log('RESTARTING CLIENT...');
    client.initialize();
  }, 10000);
});

// Main message handler
client.on('message', async msg => {
  try {
    if (msg.fromMe) return;

    const id = msg.from;
    const body = msg.body || '';
    const ts = msg.timestamp || Date.now();

    // Try to get contact pushname
    let pushname = null;
    try {
      const cobj = await client.getContactById(id);
      pushname = cobj.pushname || cobj.name || cobj.number || null;
    } catch(e){ 
      console.warn('Could not get contact info for', id);
    }

    ensureContact(id, pushname);

    // store message
    const arr = messagesByContact.get(id) || [];
    arr.push({ from: id, body, ts });
    if (arr.length > 1000) arr.shift();
    messagesByContact.set(id, arr);

    // update contact meta
    const c = contacts.get(id) || {};
    c.lastMsg = body;
    
    // if contact disabled, increment unread and do NOT reply
    if (!c.active) {
      c.unread = (c.unread || 0) + 1;
      contacts.set(id, c);
      emitContactsToAll();

      // still emit to dashboard and buffer
      const payload = { from: id, body, ts };
      io.emit('message', payload);
      
      const key = `${id}-${ts}`;
      if (!lastMessagesBuffer.find(x => x._key === key)) {
        lastMessagesBuffer.push(Object.assign({ _key: key }, payload));
        if (lastMessagesBuffer.length > 1000) lastMessagesBuffer.shift();
      }
      return;
    }

    // emit to frontend + buffer
    const payload = { from: id, body, ts };
    io.emit('message', payload);
    
    const key = `${id}-${ts}`;
    if (!lastMessagesBuffer.find(x => x._key === key)) {
      lastMessagesBuffer.push(Object.assign({ _key: key }, payload));
      if (lastMessagesBuffer.length > 1000) lastMessagesBuffer.shift();
    }

    // update contacts map
    contacts.set(id, c);
    emitContactsToAll();

    // ==== BOT LOGIC ====
    // Check silent mode
    if (silentUsers.has(id)) return;

    // per-user onboarding flow
    let user = users.get(id);
    if (!user) {
      users.set(id, { step: 'ASK_NAME_EMAIL' });
      
      if (fotoSalam) {
        await replyTyping(msg,
          'Halo Kak 😊\nSaya *Hana* dari *LPK Mitsu Gakuen*\n\n' +
          'Sebelum lanjut, mohon kirim data berikut ya:\n\n' +
          '*Nama:* \n\nContoh:\nNama: Bagas\n',
          fotoSalam);
      } else {
        await replyTyping(msg,
          'Halo Kak 😊\nSaya *Hana* dari *LPK Mitsu Gakuen*\n\n' +
          'Sebelum lanjut, mohon kirim data berikut ya:\n\n' +
          '*Nama:* \n\nContoh:\nNama: Bagas\n');
      }
      return;
    }

    // if waiting name
    if (user.step === 'ASK_NAME_EMAIL') {
      const namaMatch = body.match(/nama\s*:\s*(.+)/i);
      if (!namaMatch) {
        // try capture single-word name
        if (/^[A-Za-z\s]{2,30}$/.test(body)) {
          user.name = body.trim();
          user.step = 'DONE';
          users.set(id, user);
          
          await replyTyping(msg, 
            `Terima kasih Kak *${user.name}* 😊\n\n` +
            'Silakan pilih informasi berikut:\n\n' +
            'ℹ️ *Informasi* (tentang LPK Mitsu Gakuen)\n' +
            '📘 *Kelas* (pilihan kelas reguler/online)\n' +
            '📄 *Syarat* (syarat pendaftaran)\n' +
            '📝 *Register* (cara pendaftaran)\n' +
            '📍 *Lokasi* (alamat LPK)\n' +
            '📱 *Media Sosial LPK*\n' +
            '💰 *Biaya* (biaya pendidikan)'
          );
          return;
        }
        
        await replyTyping(msg, 
          '❗ Format belum sesuai ya Kak\n\n' +
          'Gunakan format:\n' +
          'Nama: Nama Lengkap\n' +
          'Contoh: Nama: Bagas'
        );
        return;
      }
      
      user.name = namaMatch[1].trim();
      user.step = 'DONE';
      users.set(id, user);
      
      await replyTyping(msg, 
        `Terima kasih Kak *${user.name}* 😊\n\n` +
        'Silakan pilih informasi berikut:\n\n' +
        'ℹ️ *Informasi* (tentang LPK Mitsu Gakuen)\n' +
        '📘 *Kelas* (pilihan kelas reguler/online)\n' +
        '📄 *Syarat* (syarat pendaftaran)\n' +
        '📝 *Register* (cara pendaftaran)\n' +
        '📍 *Lokasi* (alamat LPK)\n' +
        '📱 *Media Sosial LPK*\n' +
        '💰 *Biaya* (biaya pendidikan)'
      );
      return;
    }

    // after onboarding: intents
    const text = (body || '').toLowerCase();
    
    if (containsKeyword(text, keywords.informasi)) {
      if (dokumendetail) {
        await replyTyping(msg,
          '✨ *LPK Mitsu Gakuen* ✨\n\n' +
          'LPK Mitsu Gakuen adalah lembaga pendidikan bahasa asing, khususnya *Bahasa Jepang* yang mempersiapkan peserta untuk *magang, kerja, atau kuliah di Jepang*.\n\n' +
          '📌 *Apa saja yang kamu dapatkan?*\n' +
          '• Pelatihan bahasa Jepang intensif\n' +
          '• Pembinaan attitude & budaya kerja Jepang\n' +
          '• Pendampingan hingga lulus dan penempatan\n\n' +
          '📄 Untuk detail fasilitas lengkap & pilihan bidang kerja,\n' +
          'silakan cek PDF ya kak 😊',
          dokumendetail
        );
      } else {
        await replyTyping(msg,
          '✨ *LPK Mitsu Gakuen* ✨\n\n' +
          'LPK Mitsu Gakuen adalah lembaga pendidikan bahasa asing, khususnya *Bahasa Jepang* yang mempersiapkan peserta untuk *magang, kerja, atau kuliah di Jepang*.\n\n' +
          '📌 *Apa saja yang kamu dapatkan?*\n' +
          '• Pelatihan bahasa Jepang intensif\n' +
          '• Pembinaan attitude & budaya kerja Jepang\n' +
          '• Pendampingan hingga lulus dan penempatan\n\n' +
          '📞 Untuk info lebih detail, hubungi admin ya Kak 😊'
        );
      }
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.kelas)) {
      const userObj = users.get(id) || {};
      const name = userObj.name ? `*${userObj.name}*` : 'Kak';
      
      await replyTyping(msg,
        `Halo ${name}! 😊\n\n` +
        'LPK Mitsu Gakuen menyediakan 2 jenis kelas:\n\n' +
        '📘 *KELAS REGULER* (Offline)\n' +
        '• Belajar langsung di LPK\n' +
        '• Gratis asrama & makan\n' +
        '• Durasi 6 bulan\n\n' +
        '💻 *KELAS ONLINE* (Daring)\n' +
        '• Belajar via Zoom\n' +
        '• Flexibel waktu\n' +
        '• Level N5 & N3\n\n' +
        'Mau info lebih detail tentang yang mana, Kak?'
      );
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.reguler)) {
      if (fotoreguler) {
        await replyTyping(msg,
          '✨ *Kelas Reguler LPK Mitsu Gakuen* ✨\n' + 
          'Solusi Terbaik Menuju Karier di Jepang 🇯🇵\n\n' + 
          '🚀 *Ingin Bekerja ke Jepang? Mulai dari Sini!*\n' + 
          'LPK Mitsu Gakuen membuka *Pendaftaran Kelas Reguler*.\n\n' + 
          '✅ Durasi 6 bulan (Senin–Jumat)\n' + 
          '✅ Gratis asrama & makan siang\n' + 
          '✅ Bimbingan kerja & job matching sampai lulus\n' + 
          '✅ Sensei bersertifikat minimal JLPT N4\n\n' + 
          '🎯 Bidang kerja:\n' + 
          'Kaigo • Konstruksi • Otomotif • Pertanian • Perhotelan\n\n' + 
          '📌 *KUASAI BAHASA JEPANG, KUASAI PELUANG!*\n\n' + 
          'Tertarik daftar, Kak?\n' + 
          'Silakan kirim *Nama, Usia, dan Domisili* 😊', 
          fotoreguler
        );
      } else {
        await replyTyping(msg,
          '✨ *Kelas Reguler LPK Mitsu Gakuen* ✨\n' + 
          'Solusi Terbaik Menuju Karier di Jepang 🇯🇵\n\n' + 
          '🚀 *Ingin Bekerja ke Jepang? Mulai dari Sini!*\n' + 
          'LPK Mitsu Gakuen membuka *Pendaftaran Kelas Reguler*.\n\n' + 
          '✅ Durasi 6 bulan (Senin–Jumat)\n' + 
          '✅ Gratis asrama & makan siang\n' + 
          '✅ Bimbingan kerja & job matching sampai lulus\n' + 
          '✅ Sensei bersertifikat minimal JLPT N4\n\n' + 
          '🎯 Bidang kerja:\n' + 
          'Kaigo • Konstruksi • Otomotif • Pertanian • Perhotelan\n\n' + 
          '📌 *KUASAI BAHASA JEPANG, KUASAI PELUANG!*\n\n' + 
          'Tertarik daftar, Kak?\n' + 
          'Silakan kirim *Nama, Usia, dan Domisili* 😊'
        );
      }
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.online)) {
      if (fotoonline) {
        await replyTyping(msg,
          '🔥 LPK Mitsu Gakuen: Kelas Online N5 & N3 Dibuka! 🔥\n' + 
          '🇯🇵 Upgrade Level Jepang-mu Sampai N3 dari Rumah!\n\n' + 
          'LPK Mitsu Gakuen menghadirkan Kelas Online N5 dan N3 untuk pendaftaran sekarang!\n\n' +
          'Kenapa harus Kelas Online Mitsu Gakuen?\n' +
          '1. Kualitas Sensei Terjamin: Semua Sensei Kelas Online kami memiliki kualifikasi minimal JLPT N3\n' +
          '2. Materi Intensif: Total 24 kali pertemuan untuk menguasai N5 hingga N3\n' +
          '3. Solusi Karir: Cocok untuk kamu yang ingin kerja TG/Magang atau belajar sambil bekerja\n\n' + 
          'Daftar sekarang sebelum kuota penuh!\n', 
          fotoonline
        );
      } else {
        await replyTyping(msg,
          '🔥 LPK Mitsu Gakuen: Kelas Online N5 & N3 Dibuka! 🔥\n' + 
          '🇯🇵 Upgrade Level Jepang-mu Sampai N3 dari Rumah!\n\n' + 
          'LPK Mitsu Gakuen menghadirkan Kelas Online N5 dan N3 untuk pendaftaran sekarang!\n\n' +
          'Kenapa harus Kelas Online Mitsu Gakuen?\n' +
          '1. Kualitas Sensei Terjamin: Semua Sensei Kelas Online kami memiliki kualifikasi minimal JLPT N3\n' +
          '2. Materi Intensif: Total 24 kali pertemuan untuk menguasai N5 hingga N3\n' +
          '3. Solusi Karir: Cocok untuk kamu yang ingin kerja TG/Magang atau belajar sambil bekerja\n\n' + 
          'Daftar sekarang sebelum kuota penuh!\n'
        );
      }
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.register)) {
      if (fotoregister) {
        await replyTyping(msg,
          '📝 *PENDAFTARAN LPK MITSU GAKUEN*\n\n' + 
          'Silakan lakukan pendaftaran dengan salah satu cara berikut:\n\n' + 
          '📌 *Scan QR Code* pada gambar di atas\n' + 
          '📌 Atau klik link berikut:\n' + 
          '🔗 https://l1nk.dev/gRjTa\n\n' + 
          'Jika ada kendala, silakan hubungi admin ya Kak 😊', 
          fotoregister
        );
      } else {
        await replyTyping(msg,
          '📝 *PENDAFTARAN LPK MITSU GAKUEN*\n\n' + 
          'Silakan lakukan pendaftaran dengan link berikut:\n\n' + 
          '🔗 https://l1nk.dev/gRjTa\n\n' + 
          'Jika ada kendala, silakan hubungi admin ya Kak 😊'
        );
      }
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.syarat)) {
      if (fotosyarat) {
        await replyTyping(msg,
          '📄 *SYARAT PENDAFTARAN LPK MITSU GAKUEN*\n\n' + 
          '📁 *DOKUMEN YANG WAJIB DISIAPKAN:*\n' + 
          '• Ijazah SD, SMP, SMA/SMK\n' + 
          '• KTP\n' + 
          '• Kartu Keluarga (KK)\n' + 
          '• Akta Kelahiran\n' + 
          '• CV / Daftar Riwayat Hidup\n' + 
          '• Pengalaman Kerja (jika ada)\n' + 
          '• Pas Foto 3x4 & 4x6 (masing-masing 3 lembar)\n' + 
          '• Surat Persetujuan Orang Tua\n\n' + 
          '👤 *PERSYARATAN UMUM:*\n' + 
          '• Pria / Wanita\n' + 
          '• Usia 18 – 28 tahun\n' + 
          '• Tinggi badan:\n' + 
          '   - Pria min. 160 cm\n' + 
          '   - Wanita min. 150 cm\n' + 
          '• Berat badan ideal\n' + 
          '• Sehat jasmani & rohani\n' + 
          '• Tidak cacat fisik & tidak buta warna\n' + 
          '• Bebas alkohol, narkotika & zat adiktif lainnya\n' + 
          '• Tidak bertato & bertindik (khusus pria)\n' + 
          '• Memiliki motivasi tinggi, pekerja keras & komitmen\n' + 
          '• Bersedia mengikuti seluruh mekanisme pendaftaran & administrasi', 
          fotosyarat
        );
      } else {
        await replyTyping(msg,
          '📄 *SYARAT PENDAFTARAN LPK MITSU GAKUEN*\n\n' + 
          '📁 *DOKUMEN YANG WAJIB DISIAPKAN:*\n' + 
          '• Ijazah SD, SMP, SMA/SMK\n' + 
          '• KTP\n' + 
          '• Kartu Keluarga (KK)\n' + 
          '• Akta Kelahiran\n' + 
          '• CV / Daftar Riwayat Hidup\n' + 
          '• Pengalaman Kerja (jika ada)\n' + 
          '• Pas Foto 3x4 & 4x6 (masing-masing 3 lembar)\n' + 
          '• Surat Persetujuan Orang Tua\n\n' + 
          '👤 *PERSYARATAN UMUM:*\n' + 
          '• Pria / Wanita\n' + 
          '• Usia 18 – 28 tahun\n' + 
          '• Tinggi badan:\n' + 
          '   - Pria min. 160 cm\n' + 
          '   - Wanita min. 150 cm\n' + 
          '• Berat badan ideal\n' + 
          '• Sehat jasmani & rohani\n' + 
          '• Tidak cacat fisik & tidak buta warna\n' + 
          '• Bebas alkohol, narkotika & zat adiktif lainnya\n' + 
          '• Tidak bertato & bertindik (khusus pria)\n' + 
          '• Memiliki motivasi tinggi, pekerja keras & komitmen\n' + 
          '• Bersedia mengikuti seluruh mekanisme pendaftaran & administrasi'
        );
      }
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.lokasi)) {
      await replyTyping(msg, 
        '📍 *LOKASI LPK MITSU GAKUEN*\n\n' +
        '🌐 Google Maps:\n' +
        'https://maps.app.goo.gl/inrjb1fMithkc3AS8\n\n' + 
        '🏠 Alamat Lengkap:\n' +
        'Dukuh Lokojoyo, Desa Banyuputih\n' +
        'Kecamatan Banyuputih, Batang\n' +
        'Jawa Tengah, Indonesia 51271'
      );
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.sosmed)) {
      await replyTyping(msg, 
        '📱 *MEDIA SOSIAL LPK MITSU GAKUEN*\n\n' +
        '📸 Instagram:\n' +
        'https://www.instagram.com/p/DIfqcgnp1Uj/\n\n' +
        '🎵 TikTok:\n' +
        'https://www.tiktok.com/@marketing_mitsugakuen\n\n' +
        'Jangan lupa follow untuk update terbaru ya Kak! 😊'
      );
      setSilent(id);
      return;
    }

    if (containsKeyword(text, keywords.biaya)) {
      if (dokumenbiaya) {
        await replyTyping(msg,
          '💰 *BIAYA PENDIDIKAN LPK MITSU GAKUEN*\n\n' +
          'Total Biaya Pendidikan: Rp 8.000.000,- (Delapan Juta Rupiah)\n\n' + 
          '📅 *TAHAP 1: Daftar Ulang (Awal Masuk)*\n' +
          'Nominal: Rp 4.000.000,-\n\n' +
          '📅 *TAHAP 2: Pelunasan*\n' +
          'Nominal: Rp 4.000.000,-\n\n' +
          '📄 Untuk informasi lebih detail dan rincian biaya lengkap,\n' +
          'silakan cek PDF berikut ya kak 😊',
          dokumenbiaya
        );
      } else {
        await replyTyping(msg,
          '💰 *BIAYA PENDIDIKAN LPK MITSU GAKUEN*\n\n' +
          'Total Biaya Pendidikan: Rp 8.000.000,- (Delapan Juta Rupiah)\n\n' + 
          '📅 *TAHAP 1: Daftar Ulang (Awal Masuk)*\n' +
          'Nominal: Rp 4.000.000,-\n\n' +
          '📅 *TAHAP 2: Pelunasan*\n' +
          'Nominal: Rp 4.000.000,-\n\n' +
          '📞 Untuk info detail, hubungi admin ya Kak 😊'
        );
      }
      setSilent(id);
      return;
    }

    // fallback
    await replyTyping(msg, 
      'Maaf Kak, Hana belum paham pertanyaannya 🙏\n\n' +
      'Coba tanyakan tentang:\n' +
      '• ℹ️ Informasi LPK\n' +
      '• 📘 Kelas Reguler/Online\n' +
      '• 📄 Syarat Pendaftaran\n' +
      '• 📝 Cara Daftar\n' +
      '• 📍 Lokasi\n' +
      '• 📱 Media Sosial\n' +
      '• 💰 Biaya Pendidikan'
    );
    setSilent(id);

  } catch (err) {
    console.error('message handler error', err);
  }
});

// replyTyping helper
async function replyTyping(msg, text, media = null) {
  try {
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    await delay(Math.floor(Math.random() * 2000) + 1000);
    
    if (media) {
      await chat.sendMessage(media, { caption: text });
    } else {
      await msg.reply(text);
    }
  } catch (e) {
    console.error('replyTyping error', e.message);
    // Try without media if media fails
    try {
      await msg.reply(text);
    } catch (err2) {
      console.error('Even text reply failed:', err2.message);
    }
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  
  // Initialize WhatsApp client
  client.initialize();
});