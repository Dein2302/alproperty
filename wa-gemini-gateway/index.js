require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

// ================================================
// 1. CONFIG
// ================================================

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error('GEMINI_API_KEY tidak ditemukan di file .env');
}

const genAI = new GoogleGenAI({ apiKey });

// Model utama, lalu cadangan kalau 503
const MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash'];

// Free tier saat ini: 20 request/hari. Sisakan sedikit cadangan.
// Kalau sudah aktifkan billing, naikkan angka ini (mis. 1000).
const GEMINI_DAILY_BUDGET = 15;

// Jeda minimal antar request Gemini (limit per menit)
const MIN_INTERVAL_MS = 13000;

const MAX_QUEUE = 1000;
const USAGE_FILE = './gemini_usage.json';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================================================
// 2. PARSER LOKAL (GRATIS, TANPA GEMINI)
// ================================================

// Tambahkan nama proyek/lokasi lain di sini. Yang lebih spesifik taruh di atas.
const KNOWN_PROPERTIES = [
  ['Gold Coast', /\bgold\s*coast\b/i],
  ['Marina Bay', /\bmarina\s*bay\b/i],
  ['Golf Island', /\bgolf\s*island\b/i],
  ['Green Bay', /\bgreen\s*bay\b/i],
  ['Pasadena Spring', /\bpasadena\b/i],
  ['Stanford', /\bstanford\b/i],
  ['Tokyo', /\btokyo\b/i],
  ['Osaka', /\bosaka\b/i],
  ['Beppu', /\bbeppu\b/i],
  ['Milenial', /\bmilenial\b/i],
  ['Mile', /\bmill?e\b/i],
  ['Harvard', /\bharvard\b/i],
  ['Bizpark', /\bbiz\s*park\b/i],
  ['PIK 1', /\bpik\s*1\b/i],
  ['PIK', /\bpik\b/i]
];

// Kata yang BUKAN nama proyek (dipakai saat menebak nama dari baris ke-2 pesan)
const NOT_NAME_WORDS = new Set((
  'studio std dev developer br bedroom bed furnish furnished ff kosong kosongan tb depo deposit ' +
  'harga budget japri ready masuk view lantai lt lb uk ukuran unit ac wni wna juta jt dp fee survey ' +
  'nego tower zone hook hoek gandeng foto murah urgent cari mau yang ada kalo siap bayar tersewa ' +
  'sewa disewakan jual dijual bulan bln tahun thn kpr shm ppjb wts wtl wtr wtb spec area luasan arah ' +
  'lengkap full semi bagus mewah interior brand new listrik kasur kamar tidur mandi sqm dicari butuh ' +
  'info tolong bisa mohon corner tinggi rendah low high middle mid double sudah lagi'
).split(' '));

const CATEGORY_MAP = {
  WTR: 'WTR',
  WTL: 'WTL',
  WTS: 'WTS',
  WTB: 'WTB',
  SEWA: 'SEWA',
  DISEWAKAN: 'WTL', // disewakan = want to lease
  JUAL: 'WTS',      // jual / dijual = want to sell
  DIJUAL: 'WTS'
};

function detectCategory(text) {
  const match = /^\W*(wtr|wtl|wts|wtb|sewa|disewakan|jual|dijual)\b/i.exec(text);
  if (!match) return null;

  return CATEGORY_MAP[match[1].toUpperCase()] || match[1].toUpperCase();
}

function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Tebak nama proyek dari baris ke-2 pesan (hanya untuk listing WTS/WTL/JUAL/SEWA)
function guessProperty(text, category) {
  if (!['WTS', 'WTL', 'SEWA'].includes(category)) return '-';

  const lines = text
    .split('\n')
    .map((l) => l.replace(/[^\p{L}\p{N}\s&'.,()\/-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (lines.length < 2) return '-';

  let candidate = lines[1].replace(/^(apartemen|apartement|apart|apt)\s+/i, '').trim();

  if (candidate.length < 3 || candidate.length > 40) return '-';
  if (/\d/.test(candidate)) return '-';

  const words = candidate.toLowerCase().split(' ');
  if (words.length > 5) return '-';
  if (words.some((w) => NOT_NAME_WORDS.has(w.replace(/[.,()]/g, '')))) return '-';

  return titleCase(candidate);
}

function detectProperty(text, category) {
  for (const [name, regex] of KNOWN_PROPERTIES) {
    if (regex.test(text)) {
      // Rumah/Ruko/Rukan + lokasi, kalau ada
      const kind = /\b(rumah|ruko|rukan|gudang|tanah)\b/i.exec(text);
      return kind
        ? `${kind[1][0].toUpperCase()}${kind[1].slice(1).toLowerCase()} ${name}`
        : name;
    }
  }
  return guessProperty(text, category);
}

function detectUnitType(text) {
  if (/\bstudio\b/i.test(text)) return 'Studio';

  const br = /\b([1-4])\s*-?\s*(?:br(?![a-z])|bed\s*room|bedroom|bed(?![a-z]))/i.exec(text);
  if (br) return `${br[1]}BR`;

  const kt = /\b([1-4])\s*(?:kamar\s*tidur|kt)\b/i.exec(text);
  if (kt) return `${kt[1]}BR`;

  return '-';
}

function detectCondition(text) {
  if (/semi\s*furnish/i.test(text)) return 'Semi Furnished';
  if (/full\s*furnish|\bff\b/i.test(text)) return 'Full Furnished';
  if (/furnish/i.test(text)) return 'Furnished';
  if (/\bkosong(an)?\b/i.test(text)) return 'Kosongan';
  if (/\b(?:std|stnd|standar|standard)\.?\s*dev/i.test(text)) return 'Std Developer';
  if (/\bbare\b/i.test(text)) return 'Bare';
  return '-';
}

function cleanValue(v) {
  return v.replace(/[*~_]+/g, '').replace(/\s+/g, ' ').trim();
}

// TB = isi di belakang kata "TB" (sampai akhir baris, atau sampai kata Depo/Deposit).
// Beberapa baris TB digabung dengan " | ".
function detectTB(text) {
  const re = /(?:^|[\s*(~])(?:tb|t\.b)\b[ \t:.=\-]*([^\n]*?)(?=[ \t]*\b(?:depo|deposit)(?![a-z])|[ \t]*$)/gim;
  const found = [];

  let m;
  while ((m = re.exec(text)) !== null) {
    const v = cleanValue(m[1] || '');
    if (v) found.push(v);
  }

  return found.length ? found.join(' | ') : '-';
}

// Deposit = isi di belakang kata "Depo" / "Deposit" (sampai akhir baris)
function detectDeposit(text) {
  const re = /\b(?:depo|deposit)(?![a-z])[ \t:.=\-]*([^\n]*)/gi;
  const found = [];

  let m;
  while ((m = re.exec(text)) !== null) {
    const v = cleanValue(m[1] || '');
    if (v) found.push(v);
  }

  return found.length ? found.join(' | ') : '-';
}

// Satu pesan bisa berisi beberapa listing (tiap listing diawali WTS/WTL/WTR/WTB di awal baris).
// Fungsi ini memecahnya jadi beberapa blok, supaya tiap listing jadi satu baris di Sheets.
function splitListings(text) {
  const blocks = [];
  let current = [];

  for (const line of text.split('\n')) {
    const startsListing = /^\W*(wtr|wtl|wts|wtb)\b/i.test(line);

    if (startsListing && current.some((l) => l.trim())) {
      blocks.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.some((l) => l.trim())) blocks.push(current.join('\n').trim());

  return blocks.length ? blocks : [text];
}

function parseLocally(text) {
  const kategori = detectCategory(text);

  return {
    kategori: kategori || 'MANUAL',
    nama_properti: detectProperty(text, kategori),
    tipe_unit: detectUnitType(text),
    kondisi: detectCondition(text),
    tb: detectTB(text),
    deposit: detectDeposit(text),
    detail: text
  };
}

// ================================================
// 3. GEMINI (HANYA JIKA PARSER LOKAL TIDAK CUKUP)
// ================================================

// ---- Catatan pemakaian harian (tahan restart) ----

function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function loadUsage() {
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (data.date === today()) return data;
  } catch (_) { /* file belum ada */ }
  return { date: today(), count: 0 };
}

function saveUsage(usage) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (_) { /* abaikan */ }
}

let usage = loadUsage();

// Circuit breaker: kalau Google bilang kuota habis, berhenti memanggil sampai waktunya
let geminiBlockedUntil = 0;
let lastCall = 0;

function parseRetryDelayMs(msg) {
  const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(msg || '');
  if (!m) return null;

  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseFloat(m[3] || '0');

  return ((h * 60 + min) * 60 + s) * 1000;
}

function geminiAvailable() {
  if (usage.date !== today()) usage = { date: today(), count: 0 };

  if (Date.now() < geminiBlockedUntil) return false;
  if (usage.count >= GEMINI_DAILY_BUDGET) return false;

  return true;
}

async function callGemini(prompt) {
  let lastErr;

  for (let i = 0; i < MODELS.length; i++) {
    if (!geminiAvailable()) throw new Error('Gemini dilewati (kuota/limit).');

    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const model = MODELS[i];

    try {
      console.log(`⏳ Gemini ${model}...`);

      lastCall = Date.now();
      usage.count += 1;
      saveUsage(usage);

      const result = await genAI.interactions.create({ model, input: prompt });
      return result.output_text;

    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);

      console.error(`❌ Gemini ${model}:`, msg.slice(0, 160));

      if (/\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(msg)) {
        // Kuota habis: berhenti memanggil sampai waktu yang diminta Google
        const delay = parseRetryDelayMs(msg) ?? 60 * 60 * 1000;
        geminiBlockedUntil = Date.now() + delay + 1000;

        const minutes = Math.round(delay / 60000);
        console.log(`🛑 Kuota Gemini habis. Gemini dimatikan sementara ~${minutes} menit. Bot lanjut pakai parser lokal.`);

        throw err;
      }

      // 503 / error lain: coba model cadangan sekali, tanpa retry panjang
      await sleep(2000);
    }
  }

  throw lastErr;
}

function extractJson(text) {
  const clean = String(text || '').replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');

  if (start === -1 || end === -1) {
    throw new Error('Respons Gemini bukan JSON.');
  }

  return JSON.parse(clean.slice(start, end + 1));
}

async function parseWithGemini(rawText) {
  const prompt = `
Kamu adalah asisten agen properti profesional.

Ekstrak informasi listing berikut menjadi JSON valid.

Format:
{
  "kategori": "WTR / WTL / WTS / WTB / SEWA / JUAL",
  "nama_properti": "Nama apartemen atau lokasi",
  "tipe_unit": "Studio / 1BR / 2BR / 3BR / -",
  "kondisi": "Bare / Kosongan / Semi Furnished / Full Furnished / -",
  "detail": "Seluruh informasi listing"
}

Jangan mengarang informasi. Jika tidak tersedia, isi "-".

Pesan WhatsApp:
${JSON.stringify(rawText)}

Berikan JSON saja tanpa Markdown.
`;

  const outputText = await callGemini(prompt);
  return extractJson(outputText);
}

// ------------------------------------------------
// Gabungkan: lokal dulu, Gemini hanya untuk yang kosong
// ------------------------------------------------

async function parseListing(rawText) {
  const local = parseLocally(rawText);

  // Kalau nama properti sudah ketemu, tidak perlu Gemini sama sekali
  if (local.nama_properti !== '-') {
    console.log('✅ Diparsing lokal (tanpa Gemini).');
    return local;
  }

  if (!geminiAvailable()) {
    console.log('ℹ️ Nama properti tidak dikenali, Gemini tidak tersedia. Pakai hasil lokal.');
    return local;
  }

  try {
    const g = await parseWithGemini(rawText);
    const val = (v) => (v && v !== '-' ? v : null);

    console.log('✅ Diparsing dengan bantuan Gemini.');

    return {
      kategori: local.kategori !== 'MANUAL' ? local.kategori : (val(g.kategori) || 'MANUAL'),
      nama_properti: val(g.nama_properti) || '-',
      tipe_unit: local.tipe_unit !== '-' ? local.tipe_unit : (val(g.tipe_unit) || '-'),
      kondisi: local.kondisi !== '-' ? local.kondisi : (val(g.kondisi) || '-'),
      tb: local.tb,
      deposit: local.deposit,
      detail: rawText
    };

  } catch (err) {
    console.error('⚠️ Gemini gagal, pakai hasil lokal:', err.message.slice(0, 120));
    return local;
  }
}

// ================================================
// 4. ANTREAN (1 JOB PADA SATU WAKTU)
// ================================================

const queue = [];
let running = false;

function enqueue(job) {
  if (queue.length >= MAX_QUEUE) {
    console.log('⚠️ Antrean penuh, listing dilewati.');
    return;
  }

  queue.push(job);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      await job();
    } catch (err) {
      console.error('❌ Error pada job antrean:', err.message);
    }
  }

  running = false;
}

// ================================================
// 5. SAVE LISTING TO GOOGLE SHEETS
// ================================================

async function appendToSheet(data) {
  try {
    const credsPath = './credentials.json';

    if (!fs.existsSync(credsPath)) {
      console.log('⚠️ [Google Sheets] credentials.json belum ditemukan.');
      return;
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

    const formattedPrivateKey = creds.private_key?.replace(/\\n/g, '\n');

    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: formattedPrivateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(
      process.env.SPREADSHEET_ID,
      serviceAccountAuth
    );

    await doc.loadInfo();

    const sheet = doc.sheetsByIndex[0];

    if (!sheet) {
      throw new Error('Worksheet tidak ditemukan.');
    }

    const rowData = {
      'Tanggal': data.tanggal,
      'Pengirim / Agent': data.pengirim,
      'Kategori (WTS/WTL)': data.kategori,
      'Nama Properti': data.nama_properti,
      'Tipe Unit': data.tipe_unit,
      'Kondisi Unit': data.kondisi,
      'TB': data.tb,
      'Deposit': data.deposit,
      'Detail Listing': data.detail
    };

    await sheet.addRow(rowData);

    console.log('📊 [Google Sheets] Listing berhasil disimpan!');

  } catch (err) {
    console.error('❌ [Google Sheets] Error:', err.message);
  }
}

// ================================================
// 6. WHATSAPP CONNECTION
// ================================================

const PROCESSED_FILE = './processed_ids.json';
const MAX_AGE_HOURS = 48; // abaikan pesan yang lebih tua dari ini

let processedIds = new Set();

try {
  processedIds = new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')));
} catch (_) { /* file belum ada */ }

function saveProcessed() {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedIds]));
  } catch (_) { /* abaikan */ }
}

function alreadyProcessed(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;

  processedIds.add(id);

  if (processedIds.size > 2000) {
    processedIds.delete(processedIds.values().next().value);
  }

  saveProcessed();
  return false;
}

// Ambil waktu asli pesan (detik) dari field messageTimestamp
function getMessageSeconds(msg) {
  const raw = msg.messageTimestamp;
  if (raw === undefined || raw === null) return Math.floor(Date.now() / 1000);

  if (typeof raw === 'object') {
    return raw.toNumber ? raw.toNumber() : Number(raw.low);
  }

  return Number(raw);
}

// Hanya pesan yang DIAWALI kata kunci ini yang diproses
const LISTING_REGEX = /^\W*(wtr|wtl|wts|wtb|sewa|disewakan|jual|dijual)\b/i;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    shouldSyncHistoryMessage: () => false,
    browser: ['MacBook Air', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n⚡ Scan QR Code berikut di WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('🔄 Koneksi terputus. Kode:', statusCode, '| Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('❌ WhatsApp logout. Hapus folder auth_info_baileys lalu scan ulang QR Code.');
      }

    } else if (connection === 'open') {
      console.log('✅ WhatsApp berhasil terhubung!');
      console.log('🤖 Bot siap memantau grup listing properti.');
    }
  });

  // ==============================================
  // 7. MONITOR WHATSAPP GROUP MESSAGES
  // ==============================================

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = pesan baru, 'append' = pesan tertunda saat bot offline
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;

        if (!from?.endsWith('@g.us')) continue;

        const seconds = getMessageSeconds(msg);
        const ageHours = (Date.now() / 1000 - seconds) / 3600;

        if (ageHours > MAX_AGE_HOURS) continue;

        if (alreadyProcessed(msg.key.id)) continue;

        // Format: 2026-11-03 14:35:22 (waktu asli pesan, zona Jakarta)
        const tanggal = new Date(seconds * 1000)
          .toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });

        const message = msg.message;

        const text =
          message.conversation ||
          message.extendedTextMessage?.text ||
          message.imageMessage?.caption ||
          message.videoMessage?.caption ||
          message.documentMessage?.caption;

        if (!text) continue;
        if (!LISTING_REGEX.test(text)) continue;

        const sender =
          msg.pushName ||
          msg.key.participant ||
          from;

        console.log('\n📩 [LISTING TERDETEKSI]');
        console.log('Pengirim:', sender);
        console.log('Pesan:', text);

        const blocks = splitListings(text);

        if (blocks.length > 1) {
          console.log(`ℹ️ Pesan berisi ${blocks.length} listing, dipecah jadi ${blocks.length} baris.`);
        }

        for (const block of blocks) {
          enqueue(async () => {
            const parsed = await parseListing(block);

            console.log('🤖 [HASIL]:', parsed);

            await appendToSheet({
              tanggal,
              pengirim: sender,
              kategori: parsed.kategori,
              nama_properti: parsed.nama_properti,
              tipe_unit: parsed.tipe_unit,
              kondisi: parsed.kondisi,
              tb: parsed.tb,
              deposit: parsed.deposit,
              detail: parsed.detail
            });
          });
        }

      } catch (err) {
        console.error('❌ Error memproses pesan:', err.message);
      }
    }
  });
}

// ================================================
// 8. START BOT
// ================================================

connectToWhatsApp().catch((err) => {
  console.error('❌ Gagal menjalankan WhatsApp Bot:', err);
});
