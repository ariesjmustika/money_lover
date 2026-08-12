-- Supabase Schema for Dompet Kita

-- 1. Users / Wallets
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL, -- e.g., "Dompet Ayah", "Dompet Ibu"
    balance BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Categories
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    icon TEXT, -- e.g., "👶"
    budget_limit BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Transactions
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL, -- Prevent deleting transactions if category is deleted
    amount BIGINT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('debit', 'credit')),
    description TEXT,
    telegram_msg_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
