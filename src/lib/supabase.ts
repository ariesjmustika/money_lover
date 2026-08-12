import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl) {
    console.warn('Missing NEXT_PUBLIC_SUPABASE_URL');
}

// We use service role key for the backend to bypass RLS for bot operations.
export const supabase = createClient(supabaseUrl, supabaseServiceKey);
