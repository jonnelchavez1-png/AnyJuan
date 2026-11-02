// The only settings the app reads come from environment variables (see .env.example).
// A "publishable" key is designed to be public; it is safe in the browser ONLY because the database
// has row level security. Never put a secret / service-role key in a VITE_ variable.
const env = import.meta.env || {};

/** Accept the address even if it was pasted with extra bits such as /rest/v1/ or a trailing slash: keep only https://xxxx.supabase.co */
function cleanUrl(value) {
  const text = String(value || '').trim();
  try {
    const u = new URL(text);
    return u.protocol === 'https:' ? u.origin : text;
  } catch {
    return text;
  }
}

export const config = {
  // Self-service "New staff account" on the sign-in page. Off by default: the owner creates accounts in Supabase.
  allowSignup: String(env.VITE_ALLOW_SIGNUP || '').trim().toLowerCase() === 'true',
  supabaseUrl: cleanUrl(env.VITE_SUPABASE_URL),
  supabaseKey: (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '').trim(),
};

export function configProblem() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    return 'The app is not connected to a database yet. VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are missing.';
  }
  if (!/^https:\/\/.+\..+/.test(config.supabaseUrl)) {
    return 'VITE_SUPABASE_URL should look like https://your-project-ref.supabase.co';
  }
  if (/service_role/i.test(config.supabaseKey) || /^sb_secret_/.test(config.supabaseKey)) {
    return 'A secret key was found where the publishable key belongs. Remove it and use the publishable (anon) key instead.';
  }
  return null;
}
