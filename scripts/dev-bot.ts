import { config } from 'dotenv';
config({ path: '.env.local' });

async function startDev() {
    // Dynamic import prevents hoisting, ensuring dotenv loads first!
    const { bot } = await import('../src/lib/bot');

    console.log('Menghapus webhook agar bisa menggunakan mode long-polling...');
    await bot.telegram.deleteWebhook();
    console.log('Webhook terhapus.');
    
    bot.launch();
    console.log('🚀 Bot sedang berjalan di mode lokal (Long-Polling)!');
    console.log('Silakan chat bot Anda di Telegram sekarang.');

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

startDev();
