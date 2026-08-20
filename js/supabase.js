export const SUPABASE_URL = 'https://xdpizbybmatsmzovrxqr.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_XYAc2ayZ9s2HAGzJ0e2XFw_YKRi-td0';

export const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);
