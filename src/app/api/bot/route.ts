import { NextRequest, NextResponse } from 'next/server';
import { bot } from '@/lib/bot';

// Disable Next.js default body parser for this route (Not needed for App Router POST, but good to remember if switching to Pages Router)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Process the update through Telegraf
    await bot.handleUpdate(body);
    
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error handling Telegram webhook:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: 'Telegram Bot Webhook is running',
    webhook_url: 'Set this route URL in Telegram API using setWebhook' 
  });
}
