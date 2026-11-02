import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}

async function verifyLegacyPassword(password: string, encoded: string) {
  const [algorithm, count, salt, expected] = encoded.split('$', 4)
  const iterations = Number(count)
  if (algorithm !== 'pbkdf2_sha256' || !Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000 || !salt || !/^[a-f0-9]{64}$/i.test(expected ?? '')) return false
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, material, 256)
  const actual = Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('')
  return constantTimeEqual(actual, expected.toLowerCase())
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return respond({ error: 'Sign in is required' }, 401)
  const { password } = await request.json().catch(() => ({}))
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return respond({ error: 'Enter your previous account password to securely connect its journeys.' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user?.email || !user.email_confirmed_at) return respond({ error: 'Confirm your email before connecting an existing account.' }, 403)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = user.email.toLowerCase()
  const { data: legacy, error: lookupError } = await admin.from('users').select('id,auth_user_id,password_hash').eq('email', email).maybeSingle()
  if (lookupError) return respond({ error: 'Could not look up the existing profile.' }, 500)
  if (!legacy) return respond({ linked: false })
  if (legacy.auth_user_id === user.id) return respond({ linked: true })
  if (legacy.auth_user_id) return respond({ error: 'This profile is already linked to another sign-in.' }, 409)
  if (typeof legacy.password_hash !== 'string' || !await verifyLegacyPassword(password, legacy.password_hash)) return respond({ error: 'That password does not match the existing Here account.' }, 403)

  const { data: updated, error: updateError } = await admin.from('users')
    .update({ auth_user_id: user.id, password_hash: null })
    .eq('id', legacy.id).is('auth_user_id', null).select('id').maybeSingle()
  if (updateError) return respond({ error: 'Could not connect the existing profile.' }, 500)
  if (!updated) return respond({ error: 'This profile was linked elsewhere. Sign out and contact support.' }, 409)
  return respond({ linked: true })
})
