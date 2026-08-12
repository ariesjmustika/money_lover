import { Telegraf } from 'telegraf';
import { supabase } from './supabase';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

// Middleware 1: Database-backed Allowlist Security
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    try {
        const { data: users, error } = await supabase.from('allowed_users').select('*');
        if (error) throw error;

        // Auto-Bootstrap: Jika database kosong, user pertama jadi Admin
        if (!users || users.length === 0) {
            await supabase.from('allowed_users').insert({ telegram_id: userId, role: 'admin' });
            if (ctx.message && 'text' in ctx.message) {
                await ctx.reply('🎉 **Anda adalah pengguna pertama!**\nAnda otomatis diangkat menjadi **Admin**.\n\nGunakan `/adduser [ID_TELEGRAM]` untuk menambahkan anggota keluarga lain.', { parse_mode: 'Markdown' });
            }
            return next();
        }

        // Cek apakah user ada di database
        const isAllowed = users.find(u => u.telegram_id === userId);
        if (!isAllowed) {
            if (ctx.message && 'text' in ctx.message) {
                await ctx.reply(`❌ Akses ditolak.\n\nBot ini bersifat privat (Family Use Only).\nJika Anda adalah anggota keluarga, berikan ID ini ke Suami/Istri (Admin) agar ditambahkan:\n\n\`${userId}\``, { parse_mode: 'Markdown' });
            }
            return;
        }

        return next();
    } catch (err) {
        console.error('Auth Error:', err);
        if (ctx.message && 'text' in ctx.message) {
            await ctx.reply('Menunggu setup tabel `allowed_users` di Supabase...');
        }
        return;
    }
});

bot.start((ctx) => {
  ctx.reply(
    'Halo! Saya asisten keuangan keluarga Anda. 👨‍👩‍👦\n\n' +
    'Anda bisa mencatat pengeluaran langsung di chat ini, contoh:\n' +
    '`50k makan siang` atau `15000 bensin`\n\n' +
    'Ketik /help untuk info lebih lanjut.',
    { parse_mode: 'Markdown' }
  );
});

bot.help((ctx) => {
  ctx.reply(
    'Command yang tersedia:\n' +
    '/saldo - Cek saldo saat ini\n' +
    '/riwayat - Lihat 10 transaksi terakhir\n' +
    '/tambahdompet [nama] - Buat dompet baru\n' +
    '/tambahkategori [nama] - Buat kategori baru\n' +
    '/topup - Tambah saldo pemasukan\n' +
    '/laporan - Laporan & Export CSV\n' +
    '/adduser [ID] - Tambah anggota keluarga (Khusus Admin)'
  );
});

// --- /riwayat: Tampilkan 10 pengeluaran + 10 topup terakhir ---
bot.command('riwayat', async (ctx) => {
    try {
        // Fetch 10 pengeluaran terakhir
        const { data: debits } = await supabase.from('transactions').select(`
            amount, description, created_at, wallets ( name ), categories ( name )
        `).eq('type', 'debit').order('created_at', { ascending: false }).limit(10);

        // Fetch 10 topup terakhir
        const { data: credits } = await supabase.from('transactions').select(`
            amount, description, created_at, wallets ( name )
        `).eq('type', 'credit').order('created_at', { ascending: false }).limit(10);

        let msg = '📋 **Riwayat Transaksi Terakhir**\n\n';

        msg += '💸 **Pengeluaran (max 10)**\n';
        if (debits && debits.length > 0) {
            debits.forEach((t: any, i: number) => {
                const date = new Date(t.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                const cat = t.categories?.name || '-';
                msg += `${i+1}. ${date} | Rp ${Number(t.amount).toLocaleString('id-ID')} | ${t.description || '-'} [${cat}]\n`;
            });
        } else {
            msg += '_Belum ada pengeluaran._\n';
        }

        msg += '\n💰 **Pemasukan/Topup (max 10)**\n';
        if (credits && credits.length > 0) {
            credits.forEach((t: any, i: number) => {
                const date = new Date(t.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                const wallet = (t.wallets as any)?.name || '-';
                msg += `${i+1}. ${date} | Rp ${Number(t.amount).toLocaleString('id-ID')} | ${t.description || '-'} → ${wallet}\n`;
            });
        } else {
            msg += '_Belum ada pemasukan._\n';
        }

        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Gagal mengambil riwayat.');
    }
});

// --- /laporan: Menu utama laporan ---
bot.command('laporan', async (ctx) => {
    return ctx.reply('📊 Pilih jenis laporan:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📅 Bulan Ini (Chat)', callback_data: 'lap_chat_bulan' }, { text: '📅 Bulan Ini (CSV)', callback_data: 'lap_csv_bulan' }],
                [{ text: '👤 Saya (Chat)', callback_data: 'lap_chat_saya' }, { text: '👤 Saya (CSV)', callback_data: 'lap_csv_saya' }],
                [{ text: '📁 Semua (Chat)', callback_data: 'lap_chat_semua' }, { text: '📁 Semua (CSV)', callback_data: 'lap_csv_semua' }]
            ]
        }
    });
});

bot.command('adduser', async (ctx) => {
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) {
        return ctx.reply('⚠️ Format salah. Gunakan: `/adduser [ID_TELEGRAM]`', { parse_mode: 'Markdown' });
    }

    try {
        const { data: currentUser } = await supabase.from('allowed_users').select('role').eq('telegram_id', ctx.from.id.toString()).single();
        if (currentUser?.role !== 'admin') {
            return ctx.reply('❌ Hanya admin yang dapat menambahkan user.');
        }

        const { error } = await supabase.from('allowed_users').insert({ telegram_id: text, role: 'member' });
        if (error) throw error;
        
        ctx.reply(`✅ User dengan ID **${text}** berhasil ditambahkan! Mereka sekarang bisa menggunakan bot ini.`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Gagal menambahkan user.');
    }
});

bot.command('tambahkategori', async (ctx) => {
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) {
        return ctx.reply('📂 Silakan ketik nama kategori pengeluaran baru (contoh: Makan & Minum):', { 
            reply_markup: { force_reply: true, selective: true } 
        });
    }
    await createCategory(ctx, text);
});

bot.command('topup', async (ctx) => {
    return ctx.reply('💰 Berapa nominal pemasukan/topup-nya? (Ketik angka saja, contoh: 50000)', {
        reply_markup: { force_reply: true, selective: true }
    });
});

// Command untuk membuat dompet baru
bot.command('tambahdompet', async (ctx) => {
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    
    // Jika hanya mengetik /tambahdompet tanpa parameter, minta input
    if (!text) {
        return ctx.reply('Silakan ketik nama dompet baru yang ingin dibuat:', { 
            reply_markup: { force_reply: true, selective: true } 
        });
    }

    // Jika sudah beserta nama (contoh: /tambahdompet Dompet Ayah)
    await createWallet(ctx, text);
});

async function createWallet(ctx: any, name: string) {
    try {
        const { error } = await supabase.from('wallets').insert({ name: name, balance: 0 });
        if (error) throw error;
        
        ctx.reply(`✅ Dompet **"${name}"** berhasil dibuat!\nCoba ketik /saldo untuk melihatnya.`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Terjadi kesalahan saat membuat dompet. Pastikan database Anda sudah siap.');
    }
}

async function createCategory(ctx: any, name: string) {
    try {
        const { error } = await supabase.from('categories').insert({ name: name });
        if (error) throw error;
        
        ctx.reply(`✅ Kategori **"${name}"** berhasil dibuat!`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Gagal membuat kategori.');
    }
}

// Simple /saldo implementation stub
bot.command('saldo', async (ctx) => {
    try {
        const { data: wallets, error } = await supabase.from('wallets').select('*');
        if (error) throw error;

        if (!wallets || wallets.length === 0) {
            return ctx.reply('Belum ada dompet yang terdaftar.');
        }

        let total = 0;
        let response = '📊 **Ringkasan Saldo Saat Ini**\n\n';
        
        for (const wallet of wallets) {
            total += Number(wallet.balance);
            response += `💰 **${wallet.name}:** Rp ${Number(wallet.balance).toLocaleString('id-ID')}\n`;
        }

        response = `Total Gabungan: Rp ${total.toLocaleString('id-ID')}\n\n` + response;
        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error(err);
        ctx.reply('Terjadi kesalahan saat mengambil data saldo.');
    }
});

// Basic fallback for natural language & handling ForceReply
bot.on('text', async (ctx) => {
    // Handle ForceReply
    if (ctx.message.reply_to_message && 'text' in ctx.message.reply_to_message) {
        const promptText = ctx.message.reply_to_message.text;
        
        // 1. Tambah Dompet
        if (promptText === 'Silakan ketik nama dompet baru yang ingin dibuat:') {
            await createWallet(ctx, ctx.message.text);
            return;
        }

        // 2. Tambah Kategori
        if (promptText === '📂 Silakan ketik nama kategori pengeluaran baru (contoh: Makan & Minum):') {
            await createCategory(ctx, ctx.message.text);
            return;
        }

        // 3. Topup (Step 1 -> minta pilih dompet)
        if (promptText === '💰 Berapa nominal pemasukan/topup-nya? (Ketik angka saja, contoh: 50000)') {
            const nominalStr = ctx.message.text.replace(/[^0-9]/g, '');
            if (!nominalStr) {
                return ctx.reply('⚠️ Nominal tidak valid. Harus berupa angka.', { reply_markup: { force_reply: true, selective: true } });
            }
            const nominal = parseInt(nominalStr, 10);
            
            const { data: wallets, error } = await supabase.from('wallets').select('id, name');
            if (error || !wallets || wallets.length === 0) {
                return ctx.reply('Belum ada dompet. Buat dompet dulu dengan /tambahdompet');
            }

            const buttons = wallets.map(w => [{ text: w.name, callback_data: `topup_${nominal}_${w.id}` }]);
            return ctx.reply(`Pilih dompet untuk menerima topup sebesar Rp ${nominal.toLocaleString('id-ID')}:`, {
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }

    // Prevent catching commands
    if (ctx.message.text.startsWith('/')) return;
    
    // NLP Expense Parser
    // Match format like "50k makan siang" or "150rb belanja bulanan"
    const match = ctx.message.text.match(/^(\d+(?:[.,]\d+)?)(k|rb|ribu|juta)?\s+(.+)$/i);
    
    if (match) {
        let nominal = parseFloat(match[1].replace(/,/g, '.'));
        const multiplier = match[2]?.toLowerCase();
        
        if (multiplier === 'k' || multiplier === 'rb' || multiplier === 'ribu') nominal *= 1000;
        else if (multiplier === 'juta') nominal *= 1000000;
        
        const desc = match[3].trim();

        const { data: categories } = await supabase.from('categories').select('id, name');
        let matchedCategory = null;
        
        if (categories && categories.length > 0) {
            // Smart Match: Check if category name is in description
            matchedCategory = categories.find(c => desc.toLowerCase().includes(c.name.toLowerCase()));
        }

        if (matchedCategory) {
            // Category found! Proceed directly to wallet selection
            return promptWalletSelection(ctx, nominal, desc, matchedCategory.id, matchedCategory.name);
        } else {
            // Ask for Category
            if (!categories || categories.length === 0) {
                return ctx.reply('Belum ada kategori. Buat dulu dengan /tambahkategori');
            }
            
            // Limit to 10 categories for inline keyboard to avoid huge messages
            const buttons = categories.slice(0, 10).map(c => [{ text: c.name, callback_data: `selcat_${c.id}` }]);
            
            return ctx.reply(`📝 Draft Pengeluaran\nNominal: ${nominal}\nKeterangan: ${desc}\n\nPilih Kategori:`, {
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }

    ctx.reply('Format tidak dikenali. Ketik dengan format: [nominal] [keterangan]\nContoh: 50k makan siang');
});

// Helper for Wallet Prompt
async function promptWalletSelection(ctx: any, nominal: number, desc: string, categoryId: string, categoryName: string) {
    const { data: wallets } = await supabase.from('wallets').select('id, name');
    if (!wallets || wallets.length === 0) return ctx.reply('Belum ada dompet.');
    
    const buttons = wallets.map(w => [{ text: w.name, callback_data: `selwal_${w.id}` }]);
    
    // Send or edit message
    const text = `📝 Draft Pengeluaran\nNominal: ${nominal}\nKeterangan: ${desc}\nKategori ID: ${categoryId}\nKategori: ${categoryName}\n\nPilih Dompet Sumber Dana:`;
    
    if (ctx.callbackQuery) {
        return ctx.editMessageText(text, { reply_markup: { inline_keyboard: buttons } });
    } else {
        return ctx.reply(text, { reply_markup: { inline_keyboard: buttons } });
    }
}

// Handle Callback Queries (Tombol Inline)
bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data;
    // @ts-ignore
    const msgText = ctx.callbackQuery.message?.text || '';
    if (!data) return;

    // --- TOPUP FLOW ---
    if (data.startsWith('topup_')) {
        const parts = data.split('_');
        const nominal = parseInt(parts[1], 10);
        const walletId = parts[2];

        try {
            const { data: walletData } = await supabase.from('wallets').select('name, balance').eq('id', walletId).single();
            if (!walletData) throw new Error('Dompet tidak ditemukan');

            const newBalance = Number(walletData.balance) + nominal;

            await supabase.from('wallets').update({ balance: newBalance }).eq('id', walletId);
            await supabase.from('transactions').insert({
                wallet_id: walletId,
                amount: nominal,
                type: 'credit',
                description: 'Topup saldo via Bot',
                created_by: ctx.from?.id?.toString()
            });

            await ctx.deleteMessage();
            ctx.reply(`✅ **Topup berhasil!**\nRp ${nominal.toLocaleString('id-ID')} ditambahkan ke **${walletData.name}**.\n\nSaldo sekarang: Rp ${newBalance.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(err);
            ctx.reply('❌ Gagal melakukan topup.');
        }
    }

    // --- EXPENSE FLOW: SELECT CATEGORY ---
    if (data.startsWith('selcat_')) {
        const categoryId = data.replace('selcat_', '');
        
        // Parse data from message text
        const nominalMatch = msgText.match(/Nominal: (\d+)/);
        const descMatch = msgText.match(/Keterangan: (.+)/);
        
        if (nominalMatch && descMatch) {
            const nominal = parseInt(nominalMatch[1], 10);
            const desc = descMatch[1];
            
            // Get category name
            const { data: catData } = await supabase.from('categories').select('name').eq('id', categoryId).single();
            const catName = catData ? catData.name : 'Unknown';
            
            await promptWalletSelection(ctx, nominal, desc, categoryId, catName);
        }
    }

    // --- EXPENSE FLOW: SELECT WALLET (FINAL) ---
    if (data.startsWith('selwal_')) {
        const walletId = data.replace('selwal_', '');
        
        // Parse data from message text
        const nominalMatch = msgText.match(/Nominal: (\d+)/);
        const descMatch = msgText.match(/Keterangan: (.+)/);
        const catIdMatch = msgText.match(/Kategori ID: ([a-zA-Z0-9-]+)/);
        const catNameMatch = msgText.match(/Kategori: (.+)/);
        
        if (nominalMatch && descMatch && catIdMatch) {
            const nominal = parseInt(nominalMatch[1], 10);
            const desc = descMatch[1];
            const categoryId = catIdMatch[1];
            const categoryName = catNameMatch ? catNameMatch[1] : '';

            try {
                const { data: walletData } = await supabase.from('wallets').select('name, balance').eq('id', walletId).single();
                if (!walletData) throw new Error('Dompet tidak ditemukan');
    
                const newBalance = Number(walletData.balance) - nominal;
    
                // 1. Update Balance
                await supabase.from('wallets').update({ balance: newBalance }).eq('id', walletId);
                
                // 2. Insert Transaction
                await supabase.from('transactions').insert({
                    wallet_id: walletId,
                    category_id: categoryId,
                    amount: nominal,
                    type: 'debit',
                    description: desc,
                    created_by: ctx.from?.id?.toString()
                });
    
                await ctx.deleteMessage();
                ctx.reply(`✅ **Pengeluaran Dicatat!**\n\n💸 Rp ${nominal.toLocaleString('id-ID')}\n📝 ${desc}\n📂 Kategori: ${categoryName}\n💳 Sumber: ${walletData.name}\n\nSisa Saldo ${walletData.name}: Rp ${newBalance.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(err);
                ctx.reply('❌ Gagal mencatat pengeluaran.');
            }
        }
    }

    // --- REPORT FLOW ---
    if (data.startsWith('lap_')) {
        const parts = data.replace('lap_', '').split('_');
        const outputMode = parts[0]; // 'chat' or 'csv'
        const filterType = parts[1]; // 'bulan', 'saya', 'semua'

        let query = supabase.from('transactions').select(`
            id, amount, type, description, created_at, created_by,
            wallets ( name ),
            categories ( name )
        `).order('created_at', { ascending: false });

        if (filterType === 'bulan') {
            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            startOfMonth.setHours(0,0,0,0);
            query = query.gte('created_at', startOfMonth.toISOString());
        } else if (filterType === 'saya') {
            query = query.eq('created_by', ctx.from?.id?.toString());
        }

        try {
            const { data: txs, error } = await query;
            if (error) throw error;

            if (!txs || txs.length === 0) {
                return ctx.answerCbQuery('Tidak ada data transaksi untuk filter ini.');
            }

            if (outputMode === 'chat') {
                // --- OUTPUT DI TELEGRAM ---
                const debits = txs.filter((t: any) => t.type === 'debit');
                const credits = txs.filter((t: any) => t.type === 'credit');
                const totalDebit = debits.reduce((sum: number, t: any) => sum + Number(t.amount), 0);
                const totalCredit = credits.reduce((sum: number, t: any) => sum + Number(t.amount), 0);

                let msg = `📊 **Laporan ${filterType === 'bulan' ? 'Bulan Ini' : filterType === 'saya' ? 'Transaksi Saya' : 'Semua Data'}**\n\n`;
                msg += `Total Pemasukan: Rp ${totalCredit.toLocaleString('id-ID')}\n`;
                msg += `Total Pengeluaran: Rp ${totalDebit.toLocaleString('id-ID')}\n`;
                msg += `Selisih: Rp ${(totalCredit - totalDebit).toLocaleString('id-ID')}\n\n`;

                if (debits.length > 0) {
                    msg += '💸 **Pengeluaran:**\n';
                    debits.slice(0, 15).forEach((t: any, i: number) => {
                        const date = new Date(t.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                        const cat = (t.categories as any)?.name || '-';
                        msg += `${i+1}. ${date} | Rp ${Number(t.amount).toLocaleString('id-ID')} | ${t.description || '-'} [${cat}]\n`;
                    });
                    if (debits.length > 15) msg += `_...dan ${debits.length - 15} lainnya_\n`;
                }

                if (credits.length > 0) {
                    msg += '\n💰 **Pemasukan:**\n';
                    credits.slice(0, 15).forEach((t: any, i: number) => {
                        const date = new Date(t.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                        msg += `${i+1}. ${date} | Rp ${Number(t.amount).toLocaleString('id-ID')} | ${t.description || '-'}\n`;
                    });
                    if (credits.length > 15) msg += `_...dan ${credits.length - 15} lainnya_\n`;
                }

                await ctx.deleteMessage();
                return ctx.reply(msg, { parse_mode: 'Markdown' });

            } else {
                // --- OUTPUT CSV ---
                const header = 'Tanggal,Dompet,Kategori,Tipe,Nominal,Keterangan,Pencatat\n';
                const rows = txs.map((t: any) => {
                    const date = new Date(t.created_at).toISOString().split('T')[0];
                    const wallet = (t.wallets as any)?.name || '-';
                    const category = (t.categories as any)?.name || '-';
                    const desc = `"${(t.description || '').replace(/"/g, '""')}"`;
                    const creator = t.created_by || '-';
                    return `${date},${wallet},${category},${t.type},${t.amount},${desc},${creator}`;
                });
                
                const csv = header + rows.join('\n');
                const buffer = Buffer.from(csv, 'utf-8');

                await ctx.deleteMessage();
                return ctx.replyWithDocument(
                    { source: buffer, filename: `Laporan_${filterType}.csv` },
                    { caption: `📊 Berhasil di-export!\nTotal: ${txs.length} transaksi.` }
                );
            }
        } catch (err) {
            console.error(err);
            ctx.reply('❌ Gagal memproses laporan.');
        }
    }
});
