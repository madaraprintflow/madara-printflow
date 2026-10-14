import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const configReady = Boolean(url && key && !url.includes('YOUR_PROJECT'));
export const supabase = createClient(url || 'https://example.supabase.co', key || 'missing-anon-key');
export const workerUrl = (import.meta.env.VITE_PRINT_WORKER_URL as string | undefined)?.replace(/\/$/, '') || '';
