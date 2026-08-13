import { Telegraf, Context } from 'telegraf';
import { supabase } from './supabase';

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

// =====================================================================
//  KONSTANTA
// =====================================================================

const TZ = 'Asia/Jakarta';
const TZ_OFFSET = '+07:00';

const DRAFT_TTL_MS = 15 * 60 * 1000;   // draft transaksi kadaluarsa 15 menit
const AUTH_TTL_MS = 5 * 60 * 1000;     // cache izin user 5 menit
const MAX_AMOUNT = 1_000_000_000_000;  // guard salah ketik
const TG_MAX_LEN = 3800;               // limit aman pesan Telegram (real: 4096)

// =====================================================================
//  UTILITAS UMUM
// =====================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Escape untuk parse_mode HTML. WAJIB dipakai untuk semua nilai dinamis. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRp(n: number | string): string {
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

function randomId(len = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Pecah teks panjang jadi beberapa pesan tanpa memotong di tengah baris. */
function chunkText(text: string, max = TG_MAX_LEN): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// =====================================================================
//  TIMEZONE (Asia/Jakarta) — server biasanya UTC, jadi harus eksplisit
// =====================================================================

/** Tanggal "hari ini" menurut WIB, format YYYY-MM-DD. */
function jakartaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Awal hari WIB → ISO string UTC. */
function jakartaStartOfDay(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return new Date(`${y}-${p(m)}-${p(d)}T00:00:00.000${TZ_OFFSET}`).toISOString();
}

/** Akhir hari WIB → ISO string UTC. */
function jakartaEndOfDay(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return new Date(`${y}-${p(m)}-${p(d)}T23:59:59.999${TZ_OFFSET}`).toISOString();
}

/** Awal bulan berjalan menurut WIB → ISO string UTC. */
function jakartaStartOfMonth(): string {
  const [y, m] = jakartaToday().split('-').map(Number);
  return jakartaStartOfDay(y, m, 1);
}

/** Format tanggal singkat WIB, contoh "13 Agu". */
function fmtShort(iso: string): string {
  return new Date(iso).toLocaleDateString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short',
  });
}

/** Format tanggal lengkap WIB, contoh "13 Agu 2026". */
function fmtLong(iso: string): string {
  return new Date(iso).toLocaleDateString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric',
  });
}

/** YYYY-MM-DD menurut WIB (untuk CSV). */
function fmtIsoDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
}

/** Parse "dd/mm/yyyy" atau "dd-mm-yyyy" → {y, m, d} */
function parseDateArg(str: string): { y: number; m: number; d: number } | null {
  const mm = str.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (!mm) return null;
  const d = parseInt(mm[1], 10);
  const m = parseInt(mm[2], 10);
  const y = parseInt(mm[3], 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

// =====================================================================
//  PARSING NOMINAL
//  Menangani: 50k · 15000 · 50.000 · 1,5juta · 1.5jt · 250rb
// =====================================================================

const AMOUNT_RE = /^(\d[\d.,]*)\s*(k|rb|ribu|jt|juta)?\s+(.+)$/i;

function parseAmount(raw: string, unit?: string): number | null {
  let s = raw;

  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');          // 50.000 → separator ribuan
  } else if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    s = s.replace(/,/g, '');           // 50,000 → separator ribuan
  } else {
    s = s.replace(',', '.');           // 1,5 → desimal
  }

  let n = parseFloat(s);
  if (!isFinite(n) || n <= 0) return null;

  const u = unit?.toLowerCase();
  if (u === 'k' || u === 'rb' || u === 'ribu') n *= 1_000;
  else if (u === 'jt' || u === 'juta') n *= 1_000_000;

  n = Math.round(n);
  if (n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}

// =====================================================================
//  LOG PESAN BOT (dipakai /clearchat)
//  Catatan: penyimpanan in-memory. Kalau di-deploy serverless dan proses
//  sering restart, log ikut hilang → /clearchat hanya membersihkan pesan
//  sejak restart terakhir. Untuk long-running process (bot.launch()) aman.
// =====================================================================

const botMessageLog = new Map<string, Set<number>>();

function logBotMessage(chatId: number | string | undefined, messageId: number) {
  if (chatId == null) return;
  const key = String(chatId);
  if (!botMessageLog.has(key)) botMessageLog.set(key, new Set());
  const set = botMessageLog.get(key)!;
  set.add(messageId);
  // Batasi ukuran log biar tidak tumbuh selamanya
  if (set.size > 1000) {
    const sorted = Array.from(set).sort((a, b) => a - b);
    sorted.slice(0, sorted.length - 1000).forEach((id) => set.delete(id));
  }
}

/** Kirim pesan HTML + otomatis tercatat untuk /clearchat. */
async function send(ctx: Context, text: string, extra: any = {}) {
  const msg = await ctx.reply(text, { parse_mode: 'HTML', ...extra });
  logBotMessage(ctx.chat?.id, msg.message_id);
  return msg;
}

/** Kirim pesan panjang, otomatis dipecah. */
async function sendLong(ctx: Context, text: string, extra: any = {}) {
  const parts = chunkText(text);
  for (let i = 0; i < parts.length; i++) {
    await send(ctx, parts[i], i === parts.length - 1 ? extra : {});
    if (i < parts.length - 1) await sleep(120);
  }
}

// =====================================================================
//  MIDDLEWARE: AUTH + CACHE
// =====================================================================

type AuthEntry = { role: string | null; expires: number };
const authCache = new Map<string, AuthEntry>();

function cacheAuth(userId: string, role: string | null) {
  authCache.set(userId, { role, expires: Date.now() + AUTH_TTL_MS });
}

function invalidateAuth(userId?: string) {
  if (userId) authCache.delete(userId);
  else authCache.clear();
}

async function getRole(userId: string): Promise<string | null> {
  const cached = authCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.role;

  const { data, error } = await supabase
    .from('allowed_users')
    .select('role')
    .eq('telegram_id', userId)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    cacheAuth(userId, data.role);
    return data.role;
  }

  // Belum terdaftar → cek kemungkinan bootstrap (tabel masih kosong)
  const { data: rpc, error: rpcErr } = await supabase.rpc('bootstrap_first_user', {
    p_telegram_id: userId,
  });
  if (rpcErr) throw rpcErr;

  const role = (rpc as string | null) ?? null;
  cacheAuth(userId, role);
  return role;
}

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  let role: string | null;
  try {
    role = await getRole(userId);
  } catch (err) {
    console.error('[auth]', err);
    if (ctx.callbackQuery) await ctx.answerCbQuery('Gagal memverifikasi akses.').catch(() => {});
    else if (ctx.message) await ctx.reply('⚠️ Gagal terhubung ke database. Coba lagi sebentar lagi.').catch(() => {});
    return;
  }

  if (!role) {
    const msg =
      '❌ <b>Akses ditolak</b>\n\n' +
      'Bot ini bersifat privat (family use only).\n' +
      'Kalau kamu anggota keluarga, kirim ID ini ke Admin:\n\n' +
      `<code>${esc(userId)}</code>`;
    if (ctx.callbackQuery) await ctx.answerCbQuery('Akses ditolak.').catch(() => {});
    else if (ctx.message) await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  (ctx.state as any).role = role;
  return next();
});

// =====================================================================
//  DRAFT STORE — pengganti "parsing state dari teks pesan"
// =====================================================================

interface Draft {
  ownerId: string;
  chatId: number;
  kind: 'expense' | 'topup';
  amount: number;
  desc: string;
  categoryId?: string;
  categoryName?: string;
  createdAt: number;
}

const drafts = new Map<string, Draft>();

function createDraft(d: Omit<Draft, 'createdAt'>): string {
  const id = randomId();
  drafts.set(id, { ...d, createdAt: Date.now() });
  return id;
}

function getDraft(id: string, ownerId: string): Draft | 'missing' | 'forbidden' {
  const d = drafts.get(id);
  if (!d || Date.now() - d.createdAt > DRAFT_TTL_MS) {
    drafts.delete(id);
    return 'missing';
  }
  if (d.ownerId !== ownerId) return 'forbidden';
  return d;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of drafts) {
    if (now - d.createdAt > DRAFT_TTL_MS) drafts.delete(id);
  }
}, 5 * 60 * 1000).unref?.();

// =====================================================================
//  /start & /help
// =====================================================================

bot.start(async (ctx) => {
  await send(
    ctx,
    '👋 <b>Halo! Saya asisten keuangan keluarga.</b>\n\n' +
      'Cara paling cepat mencatat pengeluaran — ketik langsung di chat:\n' +
      '<code>50k makan siang</code>\n' +
      '<code>15000 bensin</code>\n\n' +
      'Ketik /help untuk daftar lengkap perintah.'
  );
});

const HELP_TEXT =
  '📖 <b>Panduan Bot Keuangan Keluarga</b>\n' +
  '━━━━━━━━━━━━━━━━━━━━\n\n' +
  '📝 <b>Catat Pengeluaran</b>\n' +
  'Ketik langsung tanpa perintah apa pun:\n' +
  '  • <code>50k makan siang</code>\n' +
  '  • <code>15000 bensin</code>\n' +
  '  • <code>1,5jt sewa kontrakan</code>\n' +
  '  • <code>50.000 belanja bulanan</code>\n' +
  '<i>Satuan yang dikenali: k · rb · ribu · jt · juta</i>\n\n' +
  '💰 <b>Saldo &amp; Dompet</b>\n' +
  '  /saldo — ringkasan saldo semua dompet\n' +
  '  /topup — catat pemasukan / isi saldo\n' +
  '  /dompet — daftar dompet\n' +
  '  /tambahdompet <i>[nama]</i> — buat dompet baru\n\n' +
  '📂 <b>Kategori</b>\n' +
  '  /kategori — daftar kategori\n' +
  '  /tambahkategori <i>[nama]</i> — buat kategori baru\n\n' +
  '📊 <b>Laporan</b>\n' +
  '  /riwayat — 10 transaksi terakhir\n' +
  '     <code>/riwayat 20</code> — 20 terakhir\n' +
  '     <code>/riwayat 10 13/08/2026</code> — satu hari\n' +
  '     <code>/riwayat 10 01/08/2026 13/08/2026</code> — rentang\n' +
  '  /laporan — rekap + export CSV\n\n' +
  '⚙️ <b>Lainnya</b>\n' +
  '  /clearchat — bersihkan pesan bot di chat ini\n' +
  '  /myid — lihat ID Telegram kamu\n' +
  '  /adduser <i>[ID]</i> — tambah anggota <i>(admin)</i>\n' +
  '  /help — tampilkan panduan ini\n\n' +
  '💡 <i>Tips: kalau nama kategori muncul di keterangan (misal "makan"), ' +
  'bot langsung memilihkan kategorinya untuk kamu.</i>';

bot.help(async (ctx) => {
  await send(ctx, HELP_TEXT);
});

bot.command('myid', async (ctx) => {
  await send(ctx, `🆔 ID Telegram kamu:\n<code>${esc(ctx.from.id)}</code>`);
});

/** Panggil sekali saat startup agar menu perintah muncul di UI Telegram. */
export async function setupCommands() {
  await bot.telegram.setMyCommands([
    { command: 'saldo', description: '💰 Cek saldo semua dompet' },
    { command: 'topup', description: '➕ Catat pemasukan / topup' },
    { command: 'riwayat', description: '📋 Riwayat transaksi' },
    { command: 'laporan', description: '📊 Laporan & export CSV' },
    { command: 'kategori', description: '📂 Daftar kategori' },
    { command: 'dompet', description: '👛 Daftar dompet' },
    { command: 'tambahdompet', description: '🆕 Buat dompet baru' },
    { command: 'tambahkategori', description: '🆕 Buat kategori baru' },
    { command: 'clearchat', description: '🧹 Bersihkan pesan bot' },
    { command: 'help', description: '📖 Panduan penggunaan' },
  ]);
}

// =====================================================================
//  DOMPET & KATEGORI
// =====================================================================

async function createWallet(ctx: Context, name: string) {
  const clean = name.trim().slice(0, 50);
  if (!clean) return send(ctx, '⚠️ Nama dompet tidak boleh kosong.');

  const { error } = await supabase.from('wallets').insert({ name: clean, balance: 0 });
  if (error) {
    console.error('[createWallet]', error);
    return send(ctx, '❌ Gagal membuat dompet.');
  }
  return send(ctx, `✅ Dompet <b>${esc(clean)}</b> berhasil dibuat.\nCek dengan /saldo`);
}

async function createCategory(ctx: Context, name: string) {
  const clean = name.trim().slice(0, 50);
  if (!clean) return send(ctx, '⚠️ Nama kategori tidak boleh kosong.');

  const { error } = await supabase.from('categories').insert({ name: clean });
  if (error) {
    console.error('[createCategory]', error);
    return send(ctx, '❌ Gagal membuat kategori.');
  }
  return send(ctx, `✅ Kategori <b>${esc(clean)}</b> berhasil dibuat.`);
}

const PROMPT_WALLET = '👛 Ketik nama dompet baru yang ingin dibuat:';
const PROMPT_CATEGORY = '📂 Ketik nama kategori pengeluaran baru (contoh: Makan & Minum):';
const PROMPT_TOPUP = '💰 Berapa nominal pemasukan/topup-nya? (contoh: 500k atau 500000)';

bot.command('tambahdompet', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return send(ctx, PROMPT_WALLET, { reply_markup: { force_reply: true, selective: true } });
  await createWallet(ctx, text);
});

bot.command('tambahkategori', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return send(ctx, PROMPT_CATEGORY, { reply_markup: { force_reply: true, selective: true } });
  await createCategory(ctx, text);
});

bot.command('dompet', async (ctx) => {
  const { data, error } = await supabase.from('wallets').select('name, balance').order('name');
  if (error) {
    console.error('[dompet]', error);
    return send(ctx, '❌ Gagal mengambil data dompet.');
  }
  if (!data?.length) return send(ctx, 'Belum ada dompet. Buat dengan /tambahdompet');

  const lines = data.map((w: any) => `• <b>${esc(w.name)}</b> — ${formatRp(w.balance)}`);
  return sendLong(ctx, '👛 <b>Daftar Dompet</b>\n\n' + lines.join('\n'));
});

bot.command('kategori', async (ctx) => {
  const { data, error } = await supabase.from('categories').select('name, keywords').order('name');
  if (error) {
    console.error('[kategori]', error);
    return send(ctx, '❌ Gagal mengambil data kategori.');
  }
  if (!data?.length) return send(ctx, 'Belum ada kategori. Buat dengan /tambahkategori');

  const lines = data.map((c: any) => {
    const kw = c.keywords ? ` <i>(${esc(c.keywords)})</i>` : '';
    return `• ${esc(c.name)}${kw}`;
  });
  return sendLong(ctx, '📂 <b>Daftar Kategori</b>\n\n' + lines.join('\n'));
});

// =====================================================================
//  /saldo
// =====================================================================

bot.command('saldo', async (ctx) => {
  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('name, balance')
    .order('name');

  if (error) {
    console.error('[saldo]', error);
    return send(ctx, '❌ Gagal mengambil data saldo.');
  }
  if (!wallets?.length) return send(ctx, 'Belum ada dompet terdaftar. Buat dengan /tambahdompet');

  let total = 0;
  const lines = wallets.map((w: any) => {
    total += Number(w.balance);
    const warn = Number(w.balance) < 0 ? ' ⚠️' : '';
    return `💳 <b>${esc(w.name)}</b>: ${formatRp(w.balance)}${warn}`;
  });

  const msg =
    '📊 <b>Ringkasan Saldo</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    `💵 <b>Total: ${formatRp(total)}</b>\n\n` +
    lines.join('\n');

  return sendLong(ctx, msg);
});

// =====================================================================
//  /topup
// =====================================================================

bot.command('topup', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) {
    return send(ctx, PROMPT_TOPUP, { reply_markup: { force_reply: true, selective: true } });
  }
  const m = arg.match(/^(\d[\d.,]*)\s*(k|rb|ribu|jt|juta)?$/i);
  const nominal = m ? parseAmount(m[1], m[2]) : null;
  if (!nominal) return send(ctx, '⚠️ Nominal tidak valid. Contoh: <code>/topup 500k</code>');
  return startTopup(ctx, nominal);
});

async function startTopup(ctx: Context, nominal: number) {
  const { data: wallets, error } = await supabase.from('wallets').select('id, name').order('name');
  if (error || !wallets?.length) {
    return send(ctx, 'Belum ada dompet. Buat dulu dengan /tambahdompet');
  }

  const draftId = createDraft({
    ownerId: String(ctx.from!.id),
    chatId: ctx.chat!.id,
    kind: 'topup',
    amount: nominal,
    desc: 'Topup saldo via Bot',
  });

  const buttons = wallets.map((w: any) => [
    { text: w.name, callback_data: `tw_${draftId}_${w.id}` },
  ]);
  buttons.push([{ text: '✖️ Batal', callback_data: `cancel_${draftId}` }]);

  return send(
    ctx,
    `💰 <b>Topup ${formatRp(nominal)}</b>\n\nPilih dompet tujuan:`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

// =====================================================================
//  /adduser
// =====================================================================

bot.command('adduser', async (ctx) => {
  if ((ctx.state as any).role !== 'admin') {
    return send(ctx, '❌ Hanya admin yang dapat menambahkan anggota.');
  }

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!/^\d{5,15}$/.test(arg)) {
    return send(
      ctx,
      '⚠️ Format salah.\nGunakan: <code>/adduser 123456789</code>\n\n' +
        'Anggota bisa melihat ID-nya dengan mengetik /myid'
    );
  }

  const { error } = await supabase
    .from('allowed_users')
    .insert({ telegram_id: arg, role: 'member' });

  if (error) {
    console.error('[adduser]', error);
    const dup = (error as any).code === '23505';
    return send(ctx, dup ? 'ℹ️ User ini sudah terdaftar.' : '❌ Gagal menambahkan user.');
  }

  invalidateAuth(arg);
  return send(ctx, `✅ User <code>${esc(arg)}</code> berhasil ditambahkan.`);
});

// =====================================================================
//  /riwayat
// =====================================================================

bot.command('riwayat', async (ctx) => {
  try {
    const args = ctx.message.text.split(/\s+/).slice(1);
    let limit = 10;
    const dateArgs: { y: number; m: number; d: number }[] = [];

    for (const arg of args) {
      const parsed = parseDateArg(arg);
      if (parsed) {
        dateArgs.push(parsed);
      } else if (/^\d+$/.test(arg) && dateArgs.length === 0) {
        limit = Math.max(1, Math.min(parseInt(arg, 10), 50));
      }
    }

    let fromISO: string | null = null;
    let toISO: string | null = null;
    let periodLabel = '';

    if (dateArgs.length === 1) {
      const a = dateArgs[0];
      fromISO = jakartaStartOfDay(a.y, a.m, a.d);
      toISO = jakartaEndOfDay(a.y, a.m, a.d);
      periodLabel = `📅 Tanggal: ${fmtLong(fromISO)}\n`;
    } else if (dateArgs.length >= 2) {
      const sorted = [dateArgs[0], dateArgs[1]].sort((x, y) =>
        jakartaStartOfDay(x.y, x.m, x.d).localeCompare(jakartaStartOfDay(y.y, y.m, y.d))
      );
      fromISO = jakartaStartOfDay(sorted[0].y, sorted[0].m, sorted[0].d);
      toISO = jakartaEndOfDay(sorted[1].y, sorted[1].m, sorted[1].d);
      periodLabel = `📅 Periode: ${fmtLong(fromISO)} — ${fmtLong(toISO)}\n`;
    }

    const build = (type: 'debit' | 'credit') => {
      let q = supabase
        .from('transactions')
        .select('amount, description, created_at, wallets ( name ), categories ( name )')
        .eq('type', type)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (fromISO) q = q.gte('created_at', fromISO);
      if (toISO) q = q.lte('created_at', toISO);
      return q;
    };

    const [debitRes, creditRes] = await Promise.all([build('debit'), build('credit')]);
    if (debitRes.error) throw debitRes.error;
    if (creditRes.error) throw creditRes.error;

    const debits = debitRes.data ?? [];
    const credits = creditRes.data ?? [];

    let msg = '📋 <b>Riwayat Transaksi</b>\n' + periodLabel + `🔢 Maks ${limit} per tipe\n\n`;

    let totalDebit = 0;
    msg += '💸 <b>Pengeluaran</b>\n';
    if (debits.length) {
      debits.forEach((t: any, i: number) => {
        totalDebit += Number(t.amount);
        const cat = t.categories?.name || '-';
        const wal = t.wallets?.name || '-';
        msg +=
          `${i + 1}. ${fmtShort(t.created_at)} · <b>${formatRp(t.amount)}</b>\n` +
          `    ${esc(t.description || '-')} · <i>${esc(cat)}</i> · ${esc(wal)}\n`;
      });
    } else {
      msg += '<i>Belum ada pengeluaran.</i>\n';
    }

    let totalCredit = 0;
    msg += '\n💰 <b>Pemasukan</b>\n';
    if (credits.length) {
      credits.forEach((t: any, i: number) => {
        totalCredit += Number(t.amount);
        const wal = t.wallets?.name || '-';
        msg +=
          `${i + 1}. ${fmtShort(t.created_at)} · <b>${formatRp(t.amount)}</b>\n` +
          `    ${esc(t.description || '-')} → ${esc(wal)}\n`;
      });
    } else {
      msg += '<i>Belum ada pemasukan.</i>\n';
    }

    const diff = totalCredit - totalDebit;
    msg +=
      '\n━━━━━━━━━━━━━━━━━━\n' +
      `💰 Total Pemasukan: ${formatRp(totalCredit)}\n` +
      `💸 Total Pengeluaran: ${formatRp(totalDebit)}\n` +
      `${diff >= 0 ? '📈' : '📉'} Selisih: ${formatRp(diff)}`;

    await sendLong(ctx, msg);
  } catch (err) {
    console.error('[riwayat]', err);
    await send(ctx, '❌ Gagal mengambil riwayat.');
  }
});

// =====================================================================
//  /laporan
// =====================================================================

bot.command('laporan', async (ctx) => {
  return send(ctx, '📊 <b>Pilih jenis laporan:</b>', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📅 Bulan Ini (Chat)', callback_data: 'lap_chat_bulan' },
          { text: '📅 Bulan Ini (CSV)', callback_data: 'lap_csv_bulan' },
        ],
        [
          { text: '👤 Saya (Chat)', callback_data: 'lap_chat_saya' },
          { text: '👤 Saya (CSV)', callback_data: 'lap_csv_saya' },
        ],
        [
          { text: '📁 Semua (Chat)', callback_data: 'lap_chat_semua' },
          { text: '📁 Semua (CSV)', callback_data: 'lap_csv_semua' },
        ],
      ],
    },
  });
});

// =====================================================================
//  /clearchat — brute-force scan mundur dari message_id sekarang
//  (TIDAK bergantung ke in-memory log, jadi aman meski serverless/
//   proses sering restart)
// =====================================================================

const CLEARCHAT_SCAN_LIMIT = 200; // jumlah message_id ke belakang yang dicoba
const CLEARCHAT_BATCH = 8;        // hindari flood limit Telegram

bot.command('clearchat', async (ctx) => {
  const chatId = ctx.chat.id;
  const currentMsgId = ctx.message.message_id;

  // Hapus pesan perintah /clearchat itu sendiri
  try { await ctx.deleteMessage(); } catch { /* ignore */ }

  const notif = await ctx.reply('🧹 Sedang membersihkan chat... Harap tunggu.');
  const notifId = notif.message_id;
  logBotMessage(chatId, notifId); // tetap dicatat untuk konsistensi, walau tak dipakai untuk deteksi lagi

  let deleted = 0;
  let failed = 0;

  // Scan mundur dari pesan sebelum /clearchat
  const scanFrom = currentMsgId - 1;
  const ids: number[] = [];
  for (let id = scanFrom; id > scanFrom - CLEARCHAT_SCAN_LIMIT && id > 0; id--) {
    if (id === notifId) continue; // jangan hapus notif kita sendiri saat masih diproses
    ids.push(id);
  }

  for (let i = 0; i < ids.length; i += CLEARCHAT_BATCH) {
    const slice = ids.slice(i, i + CLEARCHAT_BATCH);
    const results = await Promise.allSettled(
      slice.map((id) => bot.telegram.deleteMessage(chatId, id))
    );
    results.forEach((r) => {
      if (r.status === 'fulfilled') deleted++;
      else failed++; // wajar: pesan user tidak bisa dihapus bot biasa, atau sudah > 48 jam
    });
    if (i + CLEARCHAT_BATCH < ids.length) await sleep(400);
  }

  try {
    await bot.telegram.editMessageText(
      chatId,
      notifId,
      undefined,
      `✅ Selesai. <b>${deleted}</b> pesan dihapus.` +
        (failed ? `\n<i>${failed} pesan lain tidak bisa dihapus (bukan pesan bot / lebih dari 48 jam).</i>` : ''),
      { parse_mode: 'HTML' }
    );
    setTimeout(() => bot.telegram.deleteMessage(chatId, notifId).catch(() => {}), 5000);
  } catch { /* ignore */ }
});

// =====================================================================
//  PENCOCOKAN KATEGORI OTOMATIS
// =====================================================================

function matchCategory(desc: string, categories: any[]): any | null {
  const text = ' ' + desc.toLowerCase() + ' ';

  const hits = (token: string) => {
    const t = token.trim().toLowerCase();
    if (t.length < 3) return false;
    return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
  };

  // Prioritas 1: kata kunci manual (kolom `keywords`)
  for (const c of categories) {
    const kws = String(c.keywords || '').split(',').filter(Boolean);
    if (kws.some(hits)) return c;
  }

  // Prioritas 2: token dari nama kategori ("Makan & Minum" → makan, minum)
  for (const c of categories) {
    const tokens = String(c.name).split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (tokens.some(hits)) return c;
  }

  return null;
}

// =====================================================================
//  HANDLER TEKS (ForceReply + parser pengeluaran)
// =====================================================================

bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  // --- ForceReply ---
  const replyTo = ctx.message.reply_to_message;
  if (replyTo && 'text' in replyTo) {
    const prompt = replyTo.text;

    if (prompt === PROMPT_WALLET) return createWallet(ctx, text);
    if (prompt === PROMPT_CATEGORY) return createCategory(ctx, text);

    if (prompt === PROMPT_TOPUP) {
      const m = text.trim().match(/^(\d[\d.,]*)\s*(k|rb|ribu|jt|juta)?$/i);
      const nominal = m ? parseAmount(m[1], m[2]) : null;
      if (!nominal) {
        return send(ctx, '⚠️ Nominal tidak valid. Ketik angka saja, contoh: 500000', {
          reply_markup: { force_reply: true, selective: true },
        });
      }
      return startTopup(ctx, nominal);
    }
  }

  if (text.startsWith('/')) return;

  // --- Parser pengeluaran ---
  const match = text.match(AMOUNT_RE);
  if (!match) {
    return send(
      ctx,
      '🤔 Format tidak dikenali.\n\n' +
        'Gunakan: <code>[nominal] [keterangan]</code>\n' +
        'Contoh: <code>50k makan siang</code>\n\n' +
        'Ketik /help untuk panduan lengkap.'
    );
  }

  const nominal = parseAmount(match[1], match[2]);
  if (!nominal) return send(ctx, '⚠️ Nominal tidak valid atau terlalu besar.');

  const desc = match[3].trim().slice(0, 200);

  const { data: categories, error } = await supabase
    .from('categories')
    .select('id, name, keywords')
    .order('name');

  if (error) {
    console.error('[parse-expense]', error);
    return send(ctx, '❌ Gagal mengambil daftar kategori.');
  }
  if (!categories?.length) {
    return send(ctx, 'Belum ada kategori. Buat dulu dengan /tambahkategori');
  }

  const matched = matchCategory(desc, categories);

  const draftId = createDraft({
    ownerId: String(ctx.from.id),
    chatId: ctx.chat.id,
    kind: 'expense',
    amount: nominal,
    desc,
    categoryId: matched?.id,
    categoryName: matched?.name,
  });

  if (matched) return promptWallet(ctx, draftId, false);

  const buttons = categories.slice(0, 12).map((c: any) => [
    { text: c.name, callback_data: `sc_${draftId}_${c.id}` },
  ]);
  buttons.push([{ text: '✖️ Batal', callback_data: `cancel_${draftId}` }]);

  return send(
    ctx,
    '📝 <b>Draft Pengeluaran</b>\n' +
      `💸 ${formatRp(nominal)}\n` +
      `📄 ${esc(desc)}\n\n` +
      'Pilih kategori:',
    { reply_markup: { inline_keyboard: buttons } }
  );
});

// =====================================================================
//  PROMPT PILIH DOMPET
// =====================================================================

async function promptWallet(ctx: Context, draftId: string, edit: boolean) {
  const draft = drafts.get(draftId);
  if (!draft) return send(ctx, '⏳ Draft sudah kadaluarsa. Silakan ulangi.');

  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('id, name, balance')
    .order('name');

  if (error || !wallets?.length) {
    return send(ctx, 'Belum ada dompet. Buat dulu dengan /tambahdompet');
  }

  const buttons = wallets.map((w: any) => [
    {
      text: `${w.name} · ${formatRp(w.balance)}`,
      callback_data: `sw_${draftId}_${w.id}`,
    },
  ]);
  buttons.push([{ text: '✖️ Batal', callback_data: `cancel_${draftId}` }]);

  const text =
    '📝 <b>Draft Pengeluaran</b>\n' +
    `💸 ${formatRp(draft.amount)}\n` +
    `📄 ${esc(draft.desc)}\n` +
    `📂 ${esc(draft.categoryName || '-')}\n\n` +
    'Pilih dompet sumber dana:';

  const markup = { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' as const };

  if (edit) return ctx.editMessageText(text, markup);
  return send(ctx, text, { reply_markup: markup.reply_markup });
}

// =====================================================================
//  CALLBACK QUERY
// =====================================================================

bot.on('callback_query', async (ctx) => {
  const cq = ctx.callbackQuery as any;
  const data: string | undefined = cq?.data;
  const userId = String(ctx.from!.id);

  if (!data) return ctx.answerCbQuery().catch(() => {});

  try {
    // ---------- BATAL ----------
    if (data.startsWith('cancel_')) {
      const draftId = data.slice('cancel_'.length);
      const d = getDraft(draftId, userId);
      if (d === 'forbidden') return ctx.answerCbQuery('Ini bukan draft kamu.');
      drafts.delete(draftId);
      await ctx.answerCbQuery('Dibatalkan.');
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      return;
    }

    // ---------- TOPUP: PILIH DOMPET ----------
    if (data.startsWith('tw_')) {
      const [, draftId, walletId] = data.split('_');
      const draft = getDraft(draftId, userId);
      if (draft === 'missing') return ctx.answerCbQuery('⏳ Draft sudah kadaluarsa.', { show_alert: true });
      if (draft === 'forbidden') return ctx.answerCbQuery('Ini bukan draft kamu.', { show_alert: true });

      const { data: res, error } = await supabase.rpc('apply_transaction', {
        p_wallet_id: walletId,
        p_category_id: null,
        p_amount: draft.amount,
        p_type: 'credit',
        p_description: draft.desc,
        p_created_by: userId,
      });

      if (error) throw error;
      const row = Array.isArray(res) ? res[0] : res;

      drafts.delete(draftId);
      await ctx.answerCbQuery('✅ Topup tercatat');
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      return send(
        ctx,
        '✅ <b>Topup Berhasil</b>\n' +
          '━━━━━━━━━━━━━━━━━━\n' +
          `💰 ${formatRp(draft.amount)}\n` +
          `💳 ${esc(row.wallet_name)}\n\n` +
          `Saldo sekarang: <b>${formatRp(row.new_balance)}</b>`
      );
    }

    // ---------- PENGELUARAN: PILIH KATEGORI ----------
    if (data.startsWith('sc_')) {
      const [, draftId, categoryId] = data.split('_');
      const draft = getDraft(draftId, userId);
      if (draft === 'missing') return ctx.answerCbQuery('⏳ Draft sudah kadaluarsa.', { show_alert: true });
      if (draft === 'forbidden') return ctx.answerCbQuery('Ini bukan draft kamu.', { show_alert: true });

      const { data: cat } = await supabase
        .from('categories')
        .select('name')
        .eq('id', categoryId)
        .maybeSingle();

      draft.categoryId = categoryId;
      draft.categoryName = cat?.name ?? 'Tanpa Kategori';

      await ctx.answerCbQuery();
      return promptWallet(ctx, draftId, true);
    }

    // ---------- PENGELUARAN: PILIH DOMPET (FINAL) ----------
    if (data.startsWith('sw_')) {
      const [, draftId, walletId] = data.split('_');
      const draft = getDraft(draftId, userId);
      if (draft === 'missing') return ctx.answerCbQuery('⏳ Draft sudah kadaluarsa.', { show_alert: true });
      if (draft === 'forbidden') return ctx.answerCbQuery('Ini bukan draft kamu.', { show_alert: true });

      const { data: res, error } = await supabase.rpc('apply_transaction', {
        p_wallet_id: walletId,
        p_category_id: draft.categoryId ?? null,
        p_amount: draft.amount,
        p_type: 'debit',
        p_description: draft.desc,
        p_created_by: userId,
      });

      if (error) throw error;
      const row = Array.isArray(res) ? res[0] : res;

      drafts.delete(draftId);
      await ctx.answerCbQuery('✅ Tercatat');
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      const warn =
        Number(row.new_balance) < 0
          ? '\n\n⚠️ <b>Saldo dompet ini sudah minus.</b>'
          : '';

      return send(
        ctx,
        '✅ <b>Pengeluaran Dicatat</b>\n' +
          '━━━━━━━━━━━━━━━━━━\n' +
          `💸 ${formatRp(draft.amount)}\n` +
          `📄 ${esc(draft.desc)}\n` +
          `📂 ${esc(draft.categoryName || '-')}\n` +
          `💳 ${esc(row.wallet_name)}\n\n` +
          `Sisa saldo: <b>${formatRp(row.new_balance)}</b>${warn}`
      );
    }

    // ---------- LAPORAN ----------
    if (data.startsWith('lap_')) {
      const [outputMode, filterType] = data.replace('lap_', '').split('_');

      let query = supabase
        .from('transactions')
        .select('id, amount, type, description, created_at, created_by, wallets ( name ), categories ( name )')
        .order('created_at', { ascending: false });

      if (filterType === 'bulan') {
        query = query.gte('created_at', jakartaStartOfMonth());
      } else if (filterType === 'saya') {
        query = query.eq('created_by', userId);
      }

      const { data: txs, error } = await query;
      if (error) throw error;

      if (!txs?.length) {
        return ctx.answerCbQuery('Tidak ada data untuk filter ini.', { show_alert: true });
      }

      await ctx.answerCbQuery('Memproses...');

      const debits = txs.filter((t: any) => t.type === 'debit');
      const credits = txs.filter((t: any) => t.type === 'credit');
      const totalDebit = debits.reduce((s: number, t: any) => s + Number(t.amount), 0);
      const totalCredit = credits.reduce((s: number, t: any) => s + Number(t.amount), 0);

      const title =
        filterType === 'bulan' ? 'Bulan Ini' : filterType === 'saya' ? 'Transaksi Saya' : 'Semua Data';

      if (outputMode === 'chat') {
        // Rekap per kategori
        const byCat = new Map<string, number>();
        for (const t of debits as any[]) {
          const name = t.categories?.name || 'Tanpa Kategori';
          byCat.set(name, (byCat.get(name) ?? 0) + Number(t.amount));
        }
        const catLines = Array.from(byCat.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, sum]) => {
            const pct = totalDebit ? Math.round((sum / totalDebit) * 100) : 0;
            return `  • ${esc(name)}: ${formatRp(sum)} <i>(${pct}%)</i>`;
          });

        let msg =
          `📊 <b>Laporan ${esc(title)}</b>\n` +
          '━━━━━━━━━━━━━━━━━━\n' +
          `💰 Pemasukan: ${formatRp(totalCredit)}\n` +
          `💸 Pengeluaran: ${formatRp(totalDebit)}\n` +
          `${totalCredit - totalDebit >= 0 ? '📈' : '📉'} Selisih: ${formatRp(totalCredit - totalDebit)}\n` +
          `🧾 Jumlah transaksi: ${txs.length}\n`;

        if (catLines.length) {
          msg += '\n📂 <b>Pengeluaran per Kategori</b>\n' + catLines.join('\n') + '\n';
        }

        if (debits.length) {
          msg += '\n💸 <b>Pengeluaran Terakhir</b>\n';
          debits.slice(0, 15).forEach((t: any, i: number) => {
            const cat = t.categories?.name || '-';
            msg += `${i + 1}. ${fmtShort(t.created_at)} · ${formatRp(t.amount)} · ${esc(t.description || '-')} <i>[${esc(cat)}]</i>\n`;
          });
          if (debits.length > 15) msg += `<i>...dan ${debits.length - 15} lainnya</i>\n`;
        }

        if (credits.length) {
          msg += '\n💰 <b>Pemasukan Terakhir</b>\n';
          credits.slice(0, 15).forEach((t: any, i: number) => {
            msg += `${i + 1}. ${fmtShort(t.created_at)} · ${formatRp(t.amount)} · ${esc(t.description || '-')}\n`;
          });
          if (credits.length > 15) msg += `<i>...dan ${credits.length - 15} lainnya</i>\n`;
        }

        try { await ctx.deleteMessage(); } catch { /* ignore */ }
        return sendLong(ctx, msg);
      }

      // ---------- CSV ----------
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'Tanggal,Dompet,Kategori,Tipe,Nominal,Keterangan,Pencatat\n';
      const rows = (txs as any[]).map((t) =>
        [
          fmtIsoDate(t.created_at),
          q(t.wallets?.name || '-'),
          q(t.categories?.name || '-'),
          t.type,
          t.amount,
          q(t.description || ''),
          q(t.created_by || '-'),
        ].join(',')
      );

      // BOM agar Excel membaca UTF-8 dengan benar
      const buffer = Buffer.from('\uFEFF' + header + rows.join('\n'), 'utf-8');

      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      const doc = await ctx.replyWithDocument(
        { source: buffer, filename: `Laporan_${filterType}_${jakartaToday()}.csv` },
        { caption: `📊 Export berhasil — ${txs.length} transaksi.` }
      );
      logBotMessage(ctx.chat?.id, doc.message_id);
      return;
    }

    return ctx.answerCbQuery();
  } catch (err: any) {
    console.error('[callback]', err);

    const raw = String(err?.message || '');
    let userMsg = '❌ Terjadi kesalahan. Coba lagi.';
    if (raw.includes('WALLET_NOT_FOUND')) userMsg = '❌ Dompet tidak ditemukan.';
    else if (raw.includes('INVALID_AMOUNT')) userMsg = '❌ Nominal tidak valid.';

    await ctx.answerCbQuery(userMsg, { show_alert: true }).catch(() => {});
  }
});

// =====================================================================
//  GLOBAL ERROR HANDLER
// =====================================================================

bot.catch((err, ctx) => {
  console.error(`[bot.catch] update ${ctx.updateType}:`, err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});