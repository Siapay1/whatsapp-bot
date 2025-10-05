const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
require('dotenv').config();  // Load API key dari file .env

// API key dari .env
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Fungsi debug: List model tersedia (jalan otomatis saat start)
async function listModels() {
  try {
    console.log('🔍 Mengecek model tersedia via REST API...');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    const availableModels = data.models
      .filter(model => model.supportedGenerationMethods && model.supportedGenerationMethods.includes('generateContent'))
      .map(model => model.name.split('/').pop())  // Ambil nama model saja
      .join(', ');
    console.log('Model tersedia untuk generateContent:', availableModels || 'Tidak ada model! (Cek API key)');
    return availableModels;
  } catch (error) {
    console.error('❌ Error list models:', error.message);
    console.log('  -> Mungkin API key invalid atau belum aktif. Buat baru di Google AI Studio.');
    return null;
  }
}

// Fungsi untuk dapatkan respons dari Gemini AI menggunakan REST API langsung (v1, stabil)
async function getGeminiResponse(prompt) {
  try {
    console.log('Mengirim request ke Gemini AI menggunakan API key (REST v1)...');
    const modelName = 'gemini-pro';  // Model stabil, tersedia di v1
    const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Jawab pertanyaan ini secara singkat dan ramah dalam bahasa Indonesia: ${prompt}`
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      throw new Error('Respons kosong atau error dari Gemini');
    }

    const reply = data.candidates[0].content.parts[0].text;
    console.log('✅ Respons Gemini diterima:', reply.substring(0, 50) + '...');
    return reply.replace(/[*_]/g, '');  // Bersihkan markdown (italic/bold)
  } catch (error) {
    console.error('❌ Error Gemini API (REST):', error.message || error);
    if (error.message.includes('401') || error.message.includes('API key')) {
      console.error('  -> API key invalid. Periksa .env atau buat baru!');
    } else if (error.message.includes('quota') || error.message.includes('rate limit')) {
      console.error('  -> Kuota habis, tunggu atau upgrade plan.');
    } else if (error.message.includes('404') || error.message.includes('not found')) {
      console.error('  -> Model tidak tersedia. Cek output listModels().');
    } else if (error.message.includes('403')) {
      console.error('  -> Akses ditolak. Enable model di Google AI Studio.');
    }
    return 'Maaf, saya sedang mengalami kesalahan teknis. Coba lagi nanti ya! (Error: API)';
  }
}

// OPSIONAL: Test balas statis (uncomment jika ingin test WA tanpa Gemini dulu)
// async function getGeminiResponse(prompt) {
//   console.log('Test balas statis: ', prompt);
//   return `Halo! Kamu bilang: "${prompt}". Bot jalan dengan Gemini REST API!`;
// }

// Fungsi start bot (tambah listModels otomatis)
async function startBot() {
  // Jalankan listModels sekali saat start untuk debug
  await listModels();

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    generateHighQualityLinkPreview: false,
    browser: ['Chrome', '5.0.0', 'Linux'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan QR code di atas dengan WhatsApp kamu.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.error('Koneksi terputus:', lastDisconnect?.error);
      if (shouldReconnect) {
        console.log('Mencoba reconnect dalam 5 detik...');
        setTimeout(() => startBot(), 5000);
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp terhubung! Kirim pesan ke bot untuk test.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Handler pesan dengan logging debug
  sock.ev.on('messages.upsert', async (m) => {
    console.log('Event messages.upsert triggered!');
    const msg = m.messages[0];
    if (!msg.key.fromMe && msg.message) {
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const sender = isGroup ? (msg.key.participant || from) : from;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      console.log(`Pesan masuk dari ${sender} (${isGroup ? 'Grup' : 'Pribadi'}): "${text}"`);

      if (text) {
        const reply = await getGeminiResponse(text);
        await sock.sendMessage(from, { text: reply });
        console.log(`Balasan dikirim ke ${sender}: "${reply.substring(0, 50)}..."`);
      } else {
        console.log('Pesan non-teks (gambar/sticker), diabaikan.');
      }
    }
  });
}

// Jalankan bot
startBot().catch((err) => console.error('Error start bot:', err));
